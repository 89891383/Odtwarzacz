const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { 
  joinVoiceChannel, 
  createAudioPlayer, 
  createAudioResource,
  StreamType,
  NoSubscriberBehavior,
  AudioPlayerStatus,
  getVoiceConnection,
  VoiceConnectionStatus
} = require('@discordjs/voice');
const { spawn } = require('child_process');
const express = require('express');
const ffmpeg = require('ffmpeg-static');

// Konfiguracja Express (zapobiega uśpieniu na Render)
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Discord Media Bot</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; line-height: 1.6; }
          h1 { color: #5865F2; }
          .status { background-color: #2ecc71; color: white; padding: 10px; border-radius: 5px; }
          .commands { margin-top: 20px; }
          .command { background-color: #f5f5f5; padding: 10px; margin-bottom: 10px; border-radius: 5px; }
          .command-name { font-weight: bold; color: #5865F2; }
        </style>
      </head>
      <body>
        <h1>Discord Media Bot</h1>
        <p>Bot jest aktywny i działa pomyślnie!</p>
        <div class="status">Status: Online</div>
        <p>Ten interfejs web służy do utrzymania bota w działaniu na Render.com</p>
        
        <div class="commands">
          <h2>Dostępne komendy:</h2>
          <div class="command">
            <span class="command-name">/play</span> - Odtwarza multimedia z podanego URL
          </div>
          <div class="command">
            <span class="command-name">/pause</span> - Wstrzymuje odtwarzanie
          </div>
          <div class="command">
            <span class="command-name">/resume</span> - Wznawia odtwarzanie
          </div>
          <div class="command">
            <span class="command-name">/rewind</span> - Przewija do podanego czasu
          </div>
          <div class="command">
            <span class="command-name">/stop</span> - Zatrzymuje odtwarzanie
          </div>
        </div>
      </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`[SERVER] Serwer web uruchomiony na porcie ${PORT}`);
});

// Konfiguracja klienta Discord
const client = new Client({ 
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ] 
});

// Stan aktualnie odtwarzanych mediów
const streamingSessions = new Map();

// Funkcja do parsowania formatu czasu (np. 1:30, 01:30, 01:30:00)
function parseTimeString(timeStr) {
  const parts = timeStr.split(':').map(part => parseInt(part, 10));
  let seconds = 0;
  
  if (parts.length === 3) { // format 01:30:00 (godz:min:sek)
    seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) { // format 01:30 (min:sek)
    seconds = parts[0] * 60 + parts[1];
  } else if (parts.length === 1) { // format 90 (tylko sekundy)
    seconds = parts[0];
  }
  
  return seconds;
}

// Funkcja do streamowania URL przez FFmpeg
function streamFromUrl(url, guildId, startTime = 0) {
  return new Promise((resolve, reject) => {
    // Przygotowanie opcji FFmpeg
    const ffmpegArgs = [
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
    ];

    // Dodaj opcję rozpoczęcia od określonego czasu, jeśli podano
    if (startTime > 0) {
      ffmpegArgs.push('-ss', String(startTime));
    }

    // Zoptymalizowane dla Render.com (mniejsze zużycie CPU)
    ffmpegArgs.push(
      '-threads', '2',  // Ogranicz do 2 wątków
      '-i', url,
      '-f', 's16le',
      '-ar', '48000',   // Standard Discord
      '-ac', '2',       // Stereo
      '-b:a', '64k',    // Niższy bitrate = mniejsze obciążenie CPU
      '-loglevel', 'warning',
      'pipe:1'
    );

    console.log(`[FFMPEG] Uruchamianie z argumentami: ${ffmpegArgs.join(' ')}`);

    // Użyj ścieżki z ffmpeg-static
    const ffmpegProcess = spawn(ffmpeg, ffmpegArgs);
    
    // Obsługa błędów FFmpeg
    ffmpegProcess.stderr.on('data', (data) => {
      console.log(`[FFMPEG] ${data}`);
    });
    
    ffmpegProcess.on('error', (error) => {
      console.error('[FFMPEG] Błąd:', error);
      reject(error);
    });
    
    // Sukces - zwróć proces FFmpeg
    resolve(ffmpegProcess);
  });
}

// Rejestracja komend slash
async function registerCommands() {
  try {
    const commands = [
      new SlashCommandBuilder()
        .setName('play')
        .setDescription('Odtwarza media z podanego URL')
        .addStringOption(option =>
          option.setName('url')
            .setDescription('Link do pliku multimedialnego (mp4, mkv, itp.)')
            .setRequired(true)),
      new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Zatrzymuje odtwarzanie i rozłącza bota'),
      new SlashCommandBuilder()
        .setName('pause')
        .setDescription('Wstrzymuje odtwarzanie'),
      new SlashCommandBuilder()
        .setName('resume')
        .setDescription('Wznawia odtwarzanie'),
      new SlashCommandBuilder()
        .setName('rewind')
        .setDescription('Przewija do wybranego czasu')
        .addStringOption(option =>
          option.setName('time')
            .setDescription('Czas do przewinięcia (np. 1:30, 01:30, 01:30:00)')
            .setRequired(true))
    ];
    
    console.log('[DISCORD] Rozpoczęcie odświeżania komend aplikacji (/).');
    
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
    
    const data = await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands.map(command => command.toJSON()) },
    );
    
    console.log(`[DISCORD] Pomyślnie zarejestrowano ${data.length} komend slash.`);
  } catch (error) {
    console.error('[ERROR] Błąd podczas rejestracji komend:', error);
  }
}

// Gdy bot jest gotowy
client.once('ready', async () => {
  console.log(`[BOT] Zalogowano jako ${client.user.tag}!`);
  
  // Zarejestruj komendy
  await registerCommands();
  
  // Ustaw aktywność bota
  client.user.setActivity('/play', { type: 'LISTENING' });
});

// Obsługa komend
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;

  const { commandName } = interaction;
  console.log(`[BOT] Otrzymano komendę: ${commandName}`);

  if (commandName === 'play') {
    // Sprawdź, czy użytkownik jest na kanale głosowym
    if (!interaction.member.voice.channelId) {
      return interaction.reply({ 
        content: 'Musisz być na kanale głosowym, aby użyć tej komendy!', 
        ephemeral: true 
      });
    }
    
    const url = interaction.options.getString('url');
    
    // Sprawdź, czy URL wygląda poprawnie
    if (!url.match(/^https?:\/\/.+/i)) {
      return interaction.reply({ 
        content: 'Podany URL nie wygląda na prawidłowy link.', 
        ephemeral: true 
      });
    }
    
    await interaction.reply(`Przygotowuję do odtworzenia: ${url}`);
    
    try {
      // Sprawdź, czy istnieje już połączenie dla tego serwera i zniszcz je
      const existingConnection = getVoiceConnection(interaction.guildId);
      if (existingConnection) {
        const existingSession = streamingSessions.get(interaction.guildId);
        if (existingSession && existingSession.ffmpeg) {
          existingSession.ffmpeg.kill();
        }
        existingConnection.destroy();
        streamingSessions.delete(interaction.guildId);
      }
      
      // Połącz z kanałem głosowym
      const connection = joinVoiceChannel({
        channelId: interaction.member.voice.channelId,
        guildId: interaction.guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
      });

      connection.on(VoiceConnectionStatus.Disconnected, () => {
        // Obsługa rozłączenia
        console.log(`[BOT] Rozłączono z kanałem głosowym na serwerze ${interaction.guildId}`);
        const session = streamingSessions.get(interaction.guildId);
        if (session && session.ffmpeg) {
          session.ffmpeg.kill();
        }
        streamingSessions.delete(interaction.guildId);
      });
      
      // Utwórz odtwarzacz audio
      const player = createAudioPlayer({
        behaviors: {
          noSubscriber: NoSubscriberBehavior.Pause,
        },
      });
      
      // Sprawdź, czy URL jest dostępny
      await interaction.editReply('Sprawdzam dostępność URL...');
      
      // Utwórz streamowanie z URL
      const ffmpegProcess = await streamFromUrl(url, interaction.guildId);
      
      // Utwórz zasób audio ze strumienia FFmpeg
      const resource = createAudioResource(ffmpegProcess.stdout, {
        inputType: StreamType.Raw,
      });
      
      // Zapisz informacje o sesji
      streamingSessions.set(interaction.guildId, {
        url,
        player,
        ffmpeg: ffmpegProcess,
        startTime: 0,
        isPaused: false
      });
      
      // Odtwórz zasób audio
      player.play(resource);
      connection.subscribe(player);
      
      await interaction.editReply(`Odtwarzam multimedia z: ${url}`);
      
      // Obsługa zakończenia odtwarzania
      player.on(AudioPlayerStatus.Idle, () => {
        const session = streamingSessions.get(interaction.guildId);
        if (session && !session.isPaused) {
          connection.destroy();
          if (session.ffmpeg) {
            session.ffmpeg.kill();
          }
          streamingSessions.delete(interaction.guildId);
          interaction.channel.send(`Zakończono odtwarzanie: ${url}`);
        }
      });
    } catch (error) {
      console.error('[ERROR] Błąd podczas odtwarzania:', error);
      interaction.editReply('Wystąpił błąd podczas odtwarzania multimediów. Sprawdź, czy URL jest poprawny i dostępny.');
    }
  }
  
  if (commandName === 'stop') {
    try {
      const connection = getVoiceConnection(interaction.guildId);
      if (connection) {
        const session = streamingSessions.get(interaction.guildId);
        if (session && session.ffmpeg) {
          session.ffmpeg.kill();
        }
        connection.destroy();
        streamingSessions.delete(interaction.guildId);
        interaction.reply('Zatrzymano odtwarzanie i rozłączono z kanałem głosowym.');
      } else {
        interaction.reply({ 
          content: 'Bot nie jest obecnie połączony z kanałem głosowym.', 
          ephemeral: true 
        });
      }
    } catch (error) {
      console.error('[ERROR] Błąd podczas zatrzymywania:', error);
      interaction.reply({ 
        content: 'Wystąpił błąd podczas zatrzymywania odtwarzania.', 
        ephemeral: true 
      });
    }
  }
  
  if (commandName === 'pause') {
    try {
      const session = streamingSessions.get(interaction.guildId);
      if (session && session.player) {
        session.player.pause();
        session.isPaused = true;
        interaction.reply('Wstrzymano odtwarzanie.');
      } else {
        interaction.reply({ 
          content: 'Nic nie jest obecnie odtwarzane.', 
          ephemeral: true 
        });
      }
    } catch (error) {
      console.error('[ERROR] Błąd podczas wstrzymywania:', error);
      interaction.reply({ 
        content: 'Wystąpił błąd podczas wstrzymywania odtwarzania.', 
        ephemeral: true 
      });
    }
  }
  
  if (commandName === 'resume') {
    try {
      const session = streamingSessions.get(interaction.guildId);
      if (session && session.player) {
        session.player.unpause();
        session.isPaused = false;
        interaction.reply('Wznowiono odtwarzanie.');
      } else {
        interaction.reply({ 
          content: 'Nic nie jest obecnie odtwarzane lub wstrzymane.', 
          ephemeral: true 
        });
      }
    } catch (error) {
      console.error('[ERROR] Błąd podczas wznawiania:', error);
      interaction.reply({ 
        content: 'Wystąpił błąd podczas wznawiania odtwarzania.', 
        ephemeral: true 
      });
    }
  }
  
  if (commandName === 'rewind') {
    try {
      const session = streamingSessions.get(interaction.guildId);
      if (!session) {
        return interaction.reply({ 
          content: 'Nic nie jest obecnie odtwarzane.', 
          ephemeral: true 
        });
      }
      
      const timeStr = interaction.options.getString('time');
      const targetTime = parseTimeString(timeStr);
      
      if (isNaN(targetTime) || targetTime < 0) {
        return interaction.reply({ 
          content: 'Nieprawidłowy format czasu. Użyj formatu mm:ss (np. 1:30) lub hh:mm:ss (np. 01:30:00).', 
          ephemeral: true 
        });
      }
      
      await interaction.reply(`Przewijam do ${timeStr}...`);
      
      // Zaktualizuj czas rozpoczęcia dla przyszłych rewindów
      session.startTime = targetTime;
      
      // Zatrzymaj bieżące odtwarzanie
      if (session.ffmpeg) {
        session.ffmpeg.kill();
      }
      session.player.stop();
      
      // Rozpocznij nowe streamowanie od wybranego czasu
      const ffmpegProcess = await streamFromUrl(session.url, interaction.guildId, targetTime);
      
      // Utwórz nowy zasób audio
      const resource = createAudioResource(ffmpegProcess.stdout, {
        inputType: StreamType.Raw,
      });
      
      // Aktualizuj sesję
      session.ffmpeg = ffmpegProcess;
      
      // Odtwórz zasób audio
      session.player.play(resource);
      
      interaction.editReply(`Przewinięto do ${timeStr}`);
      
    } catch (error) {
      console.error('[ERROR] Błąd podczas przewijania:', error);
      interaction.reply({ 
        content: 'Wystąpił błąd podczas przewijania.', 
        ephemeral: true 
      });
    }
  }
});

// Obsługa błędów
process.on('uncaughtException', (error) => {
  console.error('[FATAL] Nieobsłużony wyjątek:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Nieobsłużone odrzucenie Promise:', reason);
});

// Zaloguj bota
const token = process.env.DISCORD_BOT_TOKEN || 'MTM1MzI5MTY3MjMwNTI3NDkwMA.GoF1tX.yAZAK9yyShp8HidArFSYgs9FkqDiXjCDo2GO4M';
client.login(token).catch(error => {
  console.error('[FATAL] Błąd logowania bota:', error);
  process.exit(1);
});

console.log('[BOT] Uruchamianie bota...');
