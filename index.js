require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { loadData, saveData } = require('./storage');
const { getUserByName, getRecentActivities } = require('./anilist');
const { getDominantColor, DEFAULT_COLOR } = require('./imageColor');

const POLL_INTERVAL_MS = (parseInt(process.env.POLL_MINUTES, 10) || 3) * 60 * 1000;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  pollAllGuilds();
  setInterval(pollAllGuilds, POLL_INTERVAL_MS);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;
  const data = loadData();
  const guildId = interaction.guildId;

  if (!guildId) {
    await interaction.reply({ content: 'This bot only works inside a server.', ephemeral: true });
    return;
  }

  if (!data.guilds[guildId]) data.guilds[guildId] = { channelId: null, users: [] };
  const guildData = data.guilds[guildId];

  try {
    if (commandName === 'track') {
      await handleTrack(interaction, data, guildData);
    } else if (commandName === 'untrack') {
      handleUntrack(interaction, data, guildData);
    } else if (commandName === 'list') {
      handleList(interaction, guildData);
    } else if (commandName === 'setchannel') {
      handleSetChannel(interaction, data, guildData);
    }
  } catch (err) {
    console.error(`Error handling /${commandName}:`, err);
    const payload = { content: 'Something went wrong. Try again in a bit.', ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload);
    } else {
      await interaction.reply(payload);
    }
  }
});

async function handleTrack(interaction, data, guildData) {
  const username = interaction.options.getString('username');
  await interaction.deferReply();

  const existing = guildData.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (existing) {
    await interaction.editReply(`Already tracking **${existing.username}**.`);
    return;
  }

  const user = await getUserByName(username);
  if (!user) {
    await interaction.editReply(`Couldn't find an AniList user named **${username}**.`);
    return;
  }

  // Record the current latest activity id so we don't dump their whole history on first track.
  const activities = await getRecentActivities(user.id, 1);
  const lastActivityId = activities.length ? activities[0].id : 0;

  guildData.users.push({
    username: user.name,
    id: user.id,
    lastActivityId,
    addedBy: interaction.user.id,
  });
  if (!guildData.channelId) guildData.channelId = interaction.channelId;
  saveData(data);

  await interaction.editReply(
    `Now tracking **${user.name}**'s AniList activity. New updates will post in <#${guildData.channelId}> and ping <@${interaction.user.id}>.`
  );
}

function handleUntrack(interaction, data, guildData) {
  const username = interaction.options.getString('username');
  const before = guildData.users.length;
  guildData.users = guildData.users.filter((u) => u.username.toLowerCase() !== username.toLowerCase());
  saveData(data);

  if (guildData.users.length < before) {
    interaction.reply(`Stopped tracking **${username}**.`);
  } else {
    interaction.reply(`Wasn't tracking anyone named **${username}**.`);
  }
}

function handleList(interaction, guildData) {
  if (!guildData.users.length) {
    interaction.reply('Not tracking any AniList profiles yet. Use `/track <username>` to add one.');
    return;
  }
  const channelLine = guildData.channelId ? `Posting to <#${guildData.channelId}>.\n\n` : '';
  const list = guildData.users
    .map((u) => `• ${u.username}${u.addedBy ? ` (pings <@${u.addedBy}>)` : ''}`)
    .join('\n');
  interaction.reply(`${channelLine}Tracking:\n${list}`);
}

function handleSetChannel(interaction, data, guildData) {
  if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
    interaction.reply({ content: 'You need the Manage Server permission to do that.', ephemeral: true });
    return;
  }
  const channel = interaction.options.getChannel('channel');
  guildData.channelId = channel.id;
  saveData(data);
  interaction.reply(`AniList updates will now post in <#${channel.id}>.`);
}

async function buildEmbed(username, activity) {
  const embed = new EmbedBuilder()
    .setTimestamp(new Date(activity.createdAt * 1000))
    .setFooter({ text: 'AniList' });

  if (activity.__typename === 'ListActivity') {
    const title = activity.media.title.english || activity.media.title.romaji;
    const colorSourceUrl = activity.media.coverImage.large || activity.media.coverImage.medium;
    const displayUrl = activity.media.coverImage.medium || colorSourceUrl;
    const color = await getDominantColor(colorSourceUrl);
    embed
      .setColor(color)
      .setAuthor({ name: username, url: `https://anilist.co/user/${username}` })
      .setTitle(`${statusVerb(activity.status)} ${title}${activity.progress ? ` (${activity.progress})` : ''}`)
      .setURL(activity.media.siteUrl)
      .setImage(displayUrl);
  } else if (activity.__typename === 'TextActivity') {
    embed
      .setColor(DEFAULT_COLOR)
      .setAuthor({ name: username, url: `https://anilist.co/user/${username}` })
      .setTitle('Posted a status update')
      .setDescription(truncate(stripMarkup(activity.text), 300))
      .setURL(activity.siteUrl);
  } else if (activity.__typename === 'MessageActivity') {
    embed
      .setColor(DEFAULT_COLOR)
      .setAuthor({ name: username, url: `https://anilist.co/user/${username}` })
      .setTitle('Posted a message')
      .setDescription(truncate(stripMarkup(activity.message), 300))
      .setURL(activity.siteUrl);
  } else {
    embed
      .setColor(DEFAULT_COLOR)
      .setAuthor({ name: username, url: `https://anilist.co/user/${username}` })
      .setTitle('New AniList activity')
      .setURL(`https://anilist.co/user/${username}`);
  }
  return embed;
}

function statusVerb(status) {
  const map = {
    watching: 'Watching',
    completed: 'Completed',
    plans: 'Plans to watch',
    dropped: 'Dropped',
    paused: 'Paused',
    rewatching: 'Rewatching',
    reading: 'Reading',
    'plans to read': 'Plans to read',
  };
  return map[status] || status;
}

function stripMarkup(text) {
  return (text || '')
    .replace(/img\d*\(.*?\)/g, '')
    .replace(/webm\(.*?\)/g, '')
    .replace(/[_*~`]/g, '')
    .trim();
}

function truncate(text, max) {
  if (!text) return '*(no text)*';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function pollAllGuilds() {
  const data = loadData();
  let changed = false;

  for (const [guildId, guildData] of Object.entries(data.guilds)) {
    if (!guildData.channelId || !guildData.users.length) continue;

    const channel = await client.channels.fetch(guildData.channelId).catch(() => null);
    if (!channel) continue;

    for (const user of guildData.users) {
      try {
        const activities = await getRecentActivities(user.id, 10);
        const newOnes = activities.filter((a) => a.id > user.lastActivityId).sort((a, b) => a.id - b.id);

        for (const activity of newOnes) {
          const embed = await buildEmbed(user.username, activity);
          const content = user.addedBy ? `<@${user.addedBy}>` : undefined;
          await channel.send({
            content,
            embeds: [embed],
            allowedMentions: user.addedBy ? { users: [user.addedBy] } : undefined,
          });
        }

        if (newOnes.length) {
          user.lastActivityId = Math.max(...newOnes.map((a) => a.id));
          changed = true;
        }
      } catch (e) {
        console.error(`Failed polling ${user.username}:`, e.message);
      }
    }
  }

  if (changed) saveData(data);
}

client.login(process.env.DISCORD_TOKEN);
