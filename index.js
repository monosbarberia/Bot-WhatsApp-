require('dotenv').config();

// Node.js 18 no expone `crypto` como variable global por defecto (sí lo hace
// Node 20+). Baileys lo necesita, así que lo agregamos manualmente aquí.
if (!globalThis.crypto) {
  globalThis.crypto = require('crypto').webcrypto;
}

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const qrcode = require('qrcode-terminal');
const P = require('pino');

// ==================== CONFIGURACIÓN ====================
// Estos valores vienen del archivo .env (ver .env.example)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const RESERVATIONS_TABLE = process.env.RESERVATIONS_TABLE || 'turnos';
const OWNER_NUMBER = process.env.OWNER_NUMBER; // ej: 5358XXXXXXX@s.whatsapp.net

if (!SUPABASE_URL || !SUPABASE_KEY || !OWNER_NUMBER) {
  console.error('❌ Faltan variables de entorno. Revisa tu archivo .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ==================== UTILIDADES DE PARSEO DEL MENSAJE ====================
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

// Convierte "miércoles 16-09-2026" a "2026-09-16" (así se guarda "fecha" en la tabla turnos)
function parseDateToISO(dateText) {
  if (!dateText) return null;
  const match = dateText.match(/(\d{2})-(\d{2})-(\d{4})/);
  if (!match) return null;
  const [, day, month, year] = match;
  return `${year}-${month}-${day}`;
}

// ==================== MANEJO DE HORAS EN FORMATO "9:30 AM" ====================
// La columna "turno" en Supabase guarda las horas así: "9:00 AM", "9:30 AM", "2:00 PM", etc.
// (sin cero a la izquierda en la hora). Estas funciones generan esos mismos strings
// para poder buscar y actualizar las filas correctas.

function parseTime12h(timeText) {
  const match = timeText.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!match) return null;
  const [, hour, minute, period] = match;
  return { hour: parseInt(hour, 10), minute: parseInt(minute, 10), period: period.toUpperCase() };
}

function to24Minutes({ hour, minute, period }) {
  let h = hour % 12;
  if (period === 'PM') h += 12;
  return h * 60 + minute;
}

function from24MinutesTo12h(totalMin) {
  const dayMinutes = 24 * 60;
  totalMin = ((totalMin % dayMinutes) + dayMinutes) % dayMinutes;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const period = h >= 12 ? 'PM' : 'AM';
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

// A partir de la hora de inicio (ej "2:00 PM") y la duración total,
// genera la lista de turnos de 30 min que hay que marcar como ocupados.
// Ej: inicio "2:00 PM", 60 min -> ["2:00 PM", "2:30 PM"]
function generateSlots12h(startTimeText, totalMinutes) {
  const parsed = parseTime12h(startTimeText);
  if (!parsed) return [];
  const startTotal = to24Minutes(parsed);
  const blocks = totalMinutes / 30;
  const slots = [];
  for (let i = 0; i < blocks; i++) {
    slots.push(from24MinutesTo12h(startTotal + i * 30));
  }
  return slots;
}

// ==================== DETECCIÓN Y PARSEO DEL MENSAJE DE RESERVA ====================

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
    horaTexto: horario,
    servicio,
    duracionMin: parseDurationToMinutes(duracion),
    precio,
    fechaTexto: fecha,
  };
}

// ==================== ACTUALIZAR SUPABASE (tabla "turnos") ====================
// La tabla ya trae, para cada fecha, una fila por cada horario del día
// con columna "estado" en 'libre'/'ocupado'. Aquí solo actualizamos a 'ocupado'
// los turnos que corresponden a la reserva (uno o varios bloques de 30 min).
async function marcarTurnosOcupados(fechaISO, slots) {
  for (const slot of slots) {
    const { error, count } = await supabase
      .from(RESERVATIONS_TABLE)
      .update({ estado: 'ocupado' })
      .eq('fecha', fechaISO)
      .eq('turno', slot);

    if (error) {
      console.error(`Error actualizando turno ${slot} (${fechaISO}):`, error);
      return false;
    }
  }
  return true;
}

// ==================== BOT PRINCIPAL ====================

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: 'silent' }),
  });

  console.log('🔄 Intentando conectar a WhatsApp...');

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('\n📱 Escanea este código desde WhatsApp Business > Dispositivos vinculados:\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('Conexión cerrada. Código:', statusCode, '| Motivo:', lastDisconnect?.error?.message);
      console.log('Reconectando:', shouldReconnect);
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

      if (!datos.fechaISO || !datos.horaTexto) {
        console.log('⚠️ No se pudo interpretar el mensaje de reserva:', text);
        return;
      }

      const slots = generateSlots12h(datos.horaTexto, datos.duracionMin);

      if (slots.length === 0) {
        console.log('⚠️ No se pudo interpretar el horario:', datos.horaTexto);
        return;
      }

      const actualizado = await marcarTurnosOcupados(datos.fechaISO, slots);

      if (!actualizado) {
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

      console.log(`✅ Reserva procesada: ${clienteNombre} - ${datos.fechaTexto} ${datos.horaTexto} (${slots.join(', ')})`);
    } catch (err) {
      console.error('Error procesando mensaje:', err);
    }
  });
}

startBot();
