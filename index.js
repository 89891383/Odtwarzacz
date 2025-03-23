const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { 
  joinVoiceChannel, 
  createAudioPlayer, 
  createAudioResource,
  StreamType,
  NoSubscriberBehavior,
  AudioPlayerStatus,
  getVoiceConnection
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
            <span class="command-name">!play [url]</span> - Odtwarza multimedia z podanego URL
          </div>
          <div class="command">
            <span class="command-name">!pause</span> - Wstrzymuje odtwarzanie
          </div>
          <div class="command">
            <span class="command-name">!resume</span> - Wznawia odtwarzanie
          </div>
          <div class="command">
            <span class="command-name">!rewind [time]</span> - Przewija do podanego czasu
          </div>
          <div class="command">
            <span class="command-name">!stop</span> - Zatrzymuje odtwarzanie
          </div>
          <div class="command">
            <span class="command-name">!help</span> - Wyświetla pomoc
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
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent
  ] 
});

// Prefix dla komend
const PREFIX = '!';

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

// Gdy bot jest gotowy
client.once('ready', () => {
  console.log(`[BOT] Zalogowano jako ${client.user.tag}!`);
  
  // Ustaw aktywność bota
  client.user.setActivity(`${PREFIX}help`, { type: 'LISTENING' });
});

// Obsługa wiadomości
client.on('messageCreate', async message => {
  // Ignoruj wiadomości od botów i wiadomości bez prefiksu
  if (message.author.bot || !message.content.startsWith(PREFIX)) return;
  
  // Parsuj komendę i argumenty
  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();
  
  console.log(`[BOT] Otrzymano komendę: ${command}`);
  
  // Komenda help
  if (command === 'help') {
    const helpEmbed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('Pomoc - Komendy Bota')
      .setDescription('Lista dostępnych komend:')
      .addFields(
        { name: `${PREFIX}play [url]`, value: 'Odtwarza multimedia z podanego URL' },
        { name: `${PREFIX}pause`, value: 'Wstrzymuje odtwarzanie' },
        { name: `${PREFIX}resume`, value: 'Wznawia odtwarzanie' },
        { name: `${PREFIX}rewind [time]`, value: 'Przewija do podanego czasu (np. 1:30, 01:30:00)' },
        { name: `${PREFIX}stop`, value: 'Zatrzymuje odtwarzanie i rozłącza bota' }
      )
      .setFooter({ text: 'Media Bot' });
      
    return message.reply({ embeds: [helpEmbed] });
  }
  
  // Komenda play
  if (command === 'play') {
    // Sprawdź, czy użytkownik jest na kanale głosowym
    if (!message.member.voice.channelId) {
      return message.reply('Musisz być na kanale głosowym, aby użyć tej komendy!');
    }
    
    const url = args[0];
    if (!url) {
      return message.reply('Musisz podać URL do odtworzenia! Użyj: `!play [url]`');
    }
    
    // Sprawdź, czy URL wygląda poprawnie
    if (!url.match(/^https?:\/\/.+/i)) {
      return message.reply('Podany URL nie wygląda na prawidłowy link.');
    }
    
    const replyMessage = await message.reply(`Przygotowuję do odtworzenia: ${url}`);
    
    try {
      // Sprawdź, czy istnieje już połączenie dla tego serwera i zniszcz je
      const existingConnection = getVoiceConnection(message.guildId);
      if (existingConnection) {
        const existingSession = streamingSessions.get(message.guildId);
        if (existingSession && existingSession.ffmpeg) {
          existingSession.ffmpeg.kill();
        }
        existingConnection.destroy();
        streamingSessions.delete(message.guildId);
      }
      
      // Połącz z kanałem głosowym
      const connection = joinVoiceChannel({
        channelId: message.member.voice.channelId,
        guildId: message.guildId,
        adapterCreator: message.guild.voiceAdapterCreator,
      });
      
      await replyMessage.edit('Sprawdzam dostępność URL...');
      
      // Utwórz odtwarzacz audio
      const player = createAudioPlayer({
        behaviors: {
          noSubscriber: NoSubscriberBehavior.Pause,
        },
      });
      
      // Utwórz streamowanie z URL
      const ffmpegProcess = await streamFromUrl(url, message.guildId);
      
      // Utwórz zasób audio ze strumienia FFmpeg
      const resource = createAudioResource(ffmpegProcess.stdout, {
        inputType: StreamType.Raw,
      });
      
      // Zapisz informacje o sesji
      streamingSessions.set(message.guildId, {
        url,
        player,
        ffmpeg: ffmpegProcess,
        startTime: 0,
        isPaused: false,
        textChannel: message.channel.id
      });
      
      // Odtwórz zasób audio
      player.play(resource);
      connection.subscribe(player);
      
      await replyMessage.edit(`Odtwarzam multimedia z: ${url}`);
      
      // Obsługa zakończenia odtwarzania
      player.on(AudioPlayerStatus.Idle, () => {
        const session = streamingSessions.get(message.guildId);
        if (session && !session.isPaused) {
          connection.destroy();
          if (session.ffmpeg) {
            session.ffmpeg.kill();
          }
          const channel = client.channels.cache.get(session.textChannel);
          if (channel) {
            channel.send(`Zakończono odtwarzanie: ${url}`);
          }
          streamingSessions.delete(message.guildId);
        }
      });
    } catch (error) {
      console.error('[ERROR] Błąd podczas odtwarzania:', error);
      replyMessage.edit('Wystąpił błąd podczas odtwarzania multimediów. Sprawdź, czy URL jest poprawny i dostępny.');
    }
  }
  
  // Komenda stop
  if (command === 'stop') {
    try {
      const connection = getVoiceConnection(message.guildId);
      if (connection) {
        const session = streamingSessions.get(message.guildId);
        if (session && session.ffmpeg) {
          session.ffmpeg.kill();
        }
        connection.destroy();
        streamingSessions.delete(message.guildId);
        message.reply('Zatrzymano odtwarzanie i rozłączono z kanałem głosowym.');
      } else {
        message.reply('Bot nie jest obecnie połączony z kanałem głosowym.');
      }
    } catch (error) {
      console.error('[ERROR] Błąd podczas zatrzymywania:', error);
      message.reply('Wystąpił błąd podczas zatrzymywania odtwarzania.');
    }
  }
  
  // Komenda pause
  if (command === 'pause') {
    try {
      const session = streamingSessions.get(message.guildId);
      if (session && session.player) {
        session.player.pause();
        session.isPaused = true;
        message.reply('Wstrzymano odtwarzanie.');
      } else {
        message.reply('Nic nie jest obecnie odtwarzane.');
      }
    } catch (error) {
      console.error('[ERROR] Błąd podczas wstrzymywania:', error);
      message.reply('Wystąpił błąd podczas wstrzymywania odtwarzania.');
    }
  }
  
  // Komenda resume
  if (command === 'resume') {
    try {
      const session = streamingSessions.get(message.guildId);
      if (session && session.player) {
        session.player.unpause();
        session.isPaused = false;
        message.reply('Wznowiono odtwarzanie.');
      } else {
        message.reply('Nic nie jest obecnie odtwarzane lub wstrzymane.');
      }
    } catch (error) {
      console.error('[ERROR] Błąd podczas wznawiania:', error);
      message.reply('Wystąpił błąd podczas wznawiania odtwarzania.');
    }
  }
  
  // Komenda rewind
  if (command === 'rewind') {
    try {
      const session = streamingSessions.get(message.guildId);
      if (!session) {
        return message.reply('Nic nie jest obecnie odtwarzane.');
      }
      
      const timeStr = args[0];
      if (!timeStr) {
        return message.reply('Musisz podać czas do przewinięcia! Użyj: `!rewind [czas]` (np. `!rewind 1:30`)');
      }
      
      const targetTime = parseTimeString(timeStr);
      
      if (isNaN(targetTime) || targetTime < 0) {
        return message.reply('Nieprawidłowy format czasu. Użyj formatu mm:ss (np. 1:30) lub hh:mm:ss (np. 01:30:00).');
      }
      
      const replyMessage = await message.reply(`Przewijam do ${timeStr}...`);
      
      // Zaktualizuj czas rozpoczęcia dla przyszłych rewindów
      session.startTime = targetTime;
      
      // Zatrzymaj bieżące odtwarzanie
      if (session.ffmpeg) {
        session.ffmpeg.kill();
      }
      session.player.stop();
      
      // Rozpocznij nowe streamowanie od wybranego czasu
      const ffmpegProcess = await streamFromUrl(session.url, message.guildId, targetTime);
      
      // Utwórz nowy zasób audio
      const resource = createAudioResource(ffmpegProcess.stdout, {
        inputType: StreamType.Raw,
      });
      
      // Aktualizuj sesję
      session.ffmpeg = ffmpegProcess;
      
      // Odtwórz zasób audio
      session.player.play(resource);
      
      replyMessage.edit(`Przewinięto do ${timeStr}`);
      
    } catch (error) {
      console.error('[ERROR] Błąd podczas przewijania:', error);
      message.reply('Wystąpił błąd podczas przewijania.');
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
