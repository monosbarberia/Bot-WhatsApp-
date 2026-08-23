require('dotenv').config();
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const qrcode = require('qrcode-terminal');
const P = require('pino');

// ==================== CONFIGURACIÓN ====================
// Estos valores vienen del archivo .env (ver .env.example)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const RESERVATIONS_TABLE = process.env.RESERVATIONS_TABLE || 'reservas';
const OWNER_NUMBER = process.env.OWNER_NUMBER; // ej: 5358XXXXXXX@s.whatsapp.net

if (!SUPABASE_URL || !SUPABASE_KEY || !OWNER_NUMBER) {
  console.error('❌ Faltan variables de entorno. Revisa tu archivo .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ==================== UTILIDADES DE PARSEO ====================
// Extrae el texto que sigue a una etiqueta como "📆Fecha:"
function extractField(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(escaped + '\\s*[:：]?\\s*(.+)', 'i');
  const match = text.match(regex);
  return match ? match[1].trim() : null;
}

// Convierte "1 hora aprox." o "30 min" a minutos, redondeado a bloques de 30
function parseDurationToMinutes(durationText) {
  if (!durationText) return 30;
  let minutes = 0;
  const hourMatch = durationText.match(/(\d+)\s*hora/i);
  const minMatch = durationText.match(/(\d+)\s*min/i);
  if (hourMatch) minutes += parseInt(hourMatch[1], 10) * 60;
  if (minMatch) minutes += parseInt(minMatch[1], 10);
  if (minutes === 0) minutes = 30;
  return Math.ceil(minutes / 30) * 30;
}

// Convierte "miércoles 16-09-2026" a "2026-09-16"
function parseDateToISO(dateText) {
  if (!dateText) return null;
  const match = dateText.match(/(\d{2})-(\d{2})-(\d{4})/);
  if (!match) return null;
  const [, day, month, year] = match;
  return `${year}-${month}-${day}`;
}

// Convierte "2:00 PM" a "14:00"
function parseTimeTo24h(timeText) {
  if (!timeText) return null;
  const match = timeText.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!match) return null;
  let [, hour, minute, period] = match;
  hour = parseInt(hour, 10);
  if (period.toUpperCase() === 'PM' && hour !== 12) hour += 12;
  if (period.toUpperCase() === 'AM' && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${minute}`;
}

function addMinutesToTime(time, minutesToAdd) {
  const [h, m] = time.split(':').map(Number);
  const totalMinutes = h * 60 + m + minutesToAdd;
  const newH = Math.floor(totalMinutes / 60) % 24;
  const newM = totalMinutes % 60;
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`;
}

// Genera la lista de bloques de 30 min que ocupa la cita
// Ej: inicio "14:00", duración 60 min -> ["14:00", "14:30"]
function generateSlots(startTime, totalMinutes) {
  const slots = [];
  let current = startTime;
  const blocks = totalMinutes / 30;
  for (let i = 0; i < blocks; i++) {
    slots.push(current);
    current = addMinutesToTime(current, 30);
  }
  return slots;
}

// ==================== DETECCIÓN Y PARSEO DEL MENSAJE ====================

function isReservationMessage(text) {
  return (
    text.includes("Mono's Barberia") &&
    text.includes('📆Fecha') &&
    text.includes('🕙Horario') &&
    text.includes('☕️Servicio')
  );
}

function parseReservation(text) {
  const fecha = extractField(text, '📆Fecha');
  const horario = extractField(text, '🕙Horario');
  const servicio = extractField(text, '☕️Servicio');
  const duracion = extractField(text, '⌛️Duracion aprox');
  const precio = extractField(text, '💰Total a pagar');

  return {
    fechaISO: parseDateToISO(fecha),
    horaISO: parseTimeTo24h(horario),
    servicio,
    duracionMin: parseDurationToMinutes(duracion),
    precio,
    fechaTexto: fecha,
    horaTexto: horario,
  };
}

// ==================== GUARDAR EN SUPABASE ====================
// ⚠️ AJUSTA los nombres de columnas aquí para que coincidan con tu tabla real
async function guardarReserva({ fechaISO, horaInicio, duracionMin, servicio, precio, clienteNombre, clienteNumero }) {
  const slots = generateSlots(horaInicio, duracionMin);

  const filas = slots.map((slot) => ({
    fecha: fechaISO,
    hora: slot,
    servicio,
    precio,
    cliente_nombre: clienteNombre,
    cliente_numero: clienteNumero,
    estado: 'reservado',
  }));

  const { error } = await supabase.from(RESERVATIONS_TABLE).insert(filas);
  if (error) {
    console.error('Error guardando en Supabase:', error);
    return false;
  }
  return true;
}

// ==================== BOT PRINCIPAL ====================

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: 'silent' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('\n📱 Escanea este código desde WhatsApp Business > Dispositivos vinculados:\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Conexión cerrada. Reconectando:', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('✅ Bot conectado a WhatsApp correctamente');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        '';

      if (!text || !isReservationMessage(text)) return;

      const clienteNumero = msg.key.remoteJid;
      const clienteNombre = msg.pushName || 'Cliente';

      const datos = parseReservation(text);

      if (!datos.fechaISO || !datos.horaISO) {
        console.log('⚠️ No se pudo interpretar el mensaje de reserva:', text);
        return;
      }

      const guardado = await guardarReserva({
        fechaISO: datos.fechaISO,
        horaInicio: datos.horaISO,
        duracionMin: datos.duracionMin,
        servicio: datos.servicio,
        precio: datos.precio,
        clienteNombre,
        clienteNumero,
      });

      if (!guardado) {
        await sock.sendMessage(clienteNumero, {
          text: 'Hubo un problema guardando tu reserva, por favor contáctanos directamente 🙏',
        });
        return;
      }

      // 1. Confirmar al cliente
      await sock.sendMessage(clienteNumero, {
        text: "¡Hola! Gracias por agendar una cita en Mono's Barberia. Nos vemos pronto.",
      });

      // 2. Avisar al dueño
      const mensajeDueno =
        `📌 Nueva reserva\n` +
        `👤 ${clienteNombre}\n` +
        `📆 ${datos.fechaTexto}\n` +
        `🕙 ${datos.horaTexto}\n` +
        `☕️ ${datos.servicio}\n` +
        `💰 ${datos.precio}`;

      await sock.sendMessage(OWNER_NUMBER, { text: mensajeDueno });

      console.log(`✅ Reserva procesada: ${clienteNombre} - ${datos.fechaTexto} ${datos.horaTexto}`);
    } catch (err) {
      console.error('Error procesando mensaje:', err);
    }
  });
}

startBot();
