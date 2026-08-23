# Bot de WhatsApp — Mono's Barbería

Este bot escucha los mensajes de reserva que los clientes envían desde la web,
y automáticamente:

1. Guarda la reserva en Supabase (en bloques de 30 min según la duración del servicio)
2. Le responde al cliente confirmando su turno
3. Te avisa a ti (el dueño) con los datos de la nueva reserva

## Cómo guarda la reserva

El bot está ajustado a tu tabla real `turnos`, que ya trae, para cada fecha,
una fila por cada horario del día (columna `turno`, ej: "9:30 AM") con una
columna `estado` que vale `libre` u `ocupado`. El bot **no crea filas
nuevas** — busca las filas que coinciden con la fecha y el horario de la
reserva (una por cada bloque de 30 min según la duración) y les cambia
`estado` a `ocupado`.

Si en algún momento tu tabla `turnos` cambia de nombre o de columnas,
avísame para reajustar `marcarTurnosOcupados` en `index.js`.

## Configuración local (para probar antes de subirlo)

1. Instala Node.js (18 o superior) si no lo tienes.
2. Copia `.env.example` a `.env` y llena tus datos reales.
3. En la carpeta del proyecto, instala las dependencias:
   ```
   npm install
   ```
4. Arranca el bot:
   ```
   npm start
   ```
5. Va a aparecer un código QR en la terminal. Desde tu iPhone:
   WhatsApp Business > Configuración > Dispositivos vinculados > Vincular un dispositivo
   y escanea el código.
6. Cuando veas "✅ Bot conectado a WhatsApp correctamente", ya está funcionando.
   Prueba enviando el mensaje de reserva desde otro número a tu WhatsApp Business.

## Subir a Railway (para que corra 24/7 sin tu teléfono ni tu compu prendida)

1. Crea una cuenta gratis en https://railway.app (puedes entrar con GitHub).
2. Sube esta carpeta a un repositorio de GitHub (puede ser privado).
3. En Railway: "New Project" > "Deploy from GitHub repo" > selecciona el repositorio.
4. En la pestaña "Variables" del proyecto en Railway, agrega las mismas variables
   de tu archivo `.env` (SUPABASE_URL, SUPABASE_KEY, RESERVATIONS_TABLE, OWNER_NUMBER).
5. Railway va a instalar dependencias y correr `npm start` automáticamente.
6. Ve a la pestaña "Deployments" > "View Logs" para ver el código QR que aparece
   en el log, y escanéalo desde tu iPhone igual que en el paso local.
7. Una vez vinculado, el bot queda guardando su sesión — no hace falta escanear
   de nuevo salvo que cierres la sesión desde el teléfono o Railway reinicie el
   proyecto y se pierda la carpeta `auth_info` (por eso conviene no borrar el
   servicio una vez esté funcionando).

## Notas importantes

- El bot solo reacciona a mensajes que contengan el formato exacto de tu web
  (con "Mono's Barberia", 📆Fecha, 🕙Horario, ☕️Servicio). Cualquier otro
  mensaje lo ignora por completo — no interfiere con tus chats normales.
- Esto usa una conexión no oficial a WhatsApp (Baileys), así que evita mandar
  mensajes masivos o repetitivos desde este número para reducir el riesgo de
  que Meta lo marque como actividad sospechosa.
- Si en algún momento cambias el texto o el orden del mensaje predeterminado
  de la web, avísame para ajustar el bot — depende de que las etiquetas
  (📆Fecha, 🕙Horario, etc.) se mantengan iguales.
