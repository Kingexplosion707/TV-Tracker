require('dotenv').config();
const { REST, Routes } = require('discord.js');
const { commands } = require('./commands');

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) {
      console.error('Missing DISCORD_TOKEN or CLIENT_ID in your .env file.');
      process.exit(1);
    }

    const route = process.env.GUILD_ID
      ? Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID)
      : Routes.applicationCommands(process.env.CLIENT_ID);

    await rest.put(route, { body: commands });

    console.log(
      `Registered ${commands.length} slash commands` +
        (process.env.GUILD_ID ? ' to your test server (instant).' : ' globally (can take up to ~1hr to show up everywhere).')
    );
  } catch (err) {
    console.error('Failed to register commands:', err);
    process.exitCode = 1;
  }
})();
