require('dotenv').config();
const http = require('http');
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { loadData, saveData } = require('./storage');
const { getUserByName, getRecentActivities, getMediaById } = require('./anilist');
const { getDominantColor, DEFAULT_COLOR } = require('./imageColor');

const POLL_INTERVAL_MS = (parseInt(process.env.POLL_MINUTES, 10) || 3) * 60 * 1000;

// Render (and most free hosts) expect something listening on a port to
// consider the service "alive". This also gives an external ping service
// (e.g. UptimeRobot) something to hit to keep the bot from sleeping.
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('AniList Discord bot is running.');
  })
  .listen(PORT, () => console.log(`Keep-alive web server listening on port ${PORT}`));

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  pollAllGuilds();
  setInterval(pollAllGuilds, POLL_INTERVAL_MS);
});

// Makes sure a guild's data object has every field newer features need,
// even for guilds that were first tracked before those features existed.
function ensureGuildData(data, guildId) {
  if (!data.guilds[guildId]) {
    data.guilds[guildId] = { channelId: null, users: [], watchlist: {}, recommendations: {} };
  }
  const guildData = data.guilds[guildId];
  if (!guildData.watchlist) guildData.watchlist = {};
  if (!guildData.recommendations) guildData.recommendations = {};
  return guildData;
}

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    await handleSlashCommand(interaction);
  } else if (interaction.isButton()) {
    await handleButton(interaction);
  }
});

async function handleSlashCommand(interaction) {
  const { commandName } = interaction;
  const guildId = interaction.guildId;

  if (!guildId) {
    await interaction.reply({ content: 'This bot only works inside a server.', ephemeral: true });
    return;
  }

  const data = loadData();
  const guildData = ensureGuildData(data, guildId);

  try {
    if (commandName === 'track') {
      await handleTrack(interaction, data, guildData);
    } else if (commandName === 'untrack') {
      handleUntrack(interaction, data, guildData);
    } else if (commandName === 'list') {
      handleList(interaction, guildData);
    } else if (commandName === 'setchannel') {
      handleSetChannel(interaction, data, guildData);
    } else if (commandName === 'watchlater') {
      handleWatchLaterList(interaction, guildData);
    } else if (commandName === 'recommendanimes') {
      handleRecommendAnimes(interaction, guildData);
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
}

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
    avatar: user.avatar?.medium || null,
  });
  if (!guildData.channelId) guildData.channelId = interaction.channelId;
  saveData(data);

  await interaction.editReply(
    `✅ Now tracking **${user.name}**'s AniList activity. New updates will post in <#${guildData.channelId}> and ping <@${interaction.user.id}>.`
  );
}

function handleUntrack(interaction, data, guildData) {
  const username = interaction.options.getString('username');
  const before = guildData.users.length;
  guildData.users = guildData.users.filter((u) => u.username.toLowerCase() !== username.toLowerCase());
  saveData(data);

  if (guildData.users.length < before) {
    interaction.reply(`🗑️ Stopped tracking **${username}**.`);
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

function handleWatchLaterList(interaction, guildData) {
  const list = guildData.watchlist[interaction.user.id] || [];
  if (!list.length) {
    interaction.reply({
      content: 'Your watch later list is empty. Click 📌 **Watch Later** on any activity to add one!',
      ephemeral: true,
    });
    return;
  }
  const lines = list.map((e, i) => `${i + 1}. **[${e.title}](${e.siteUrl})**`).join('\n');
  const embed = new EmbedBuilder()
    .setColor(DEFAULT_COLOR)
    .setTitle('📌 Your Watch Later List')
    .setDescription(lines);
  interaction.reply({ embeds: [embed], ephemeral: true });
}

function handleRecommendAnimes(interaction, guildData) {
  const recs = guildData.recommendations || {};
  const entries = Object.entries(recs)
    .filter(([, r]) => r.title && r.recommendedBy && r.recommendedBy.length > 0)
    .map(([mediaId, r]) => ({ mediaId, title: r.title, siteUrl: r.siteUrl, count: r.recommendedBy.length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  if (!entries.length) {
    interaction.reply('No recommendations yet — click ⭐ **Recommend** on an activity to start the leaderboard!');
    return;
  }

  const medals = ['🥇', '🥈', '🥉'];
  const lines = entries
    .map(
      (e, i) =>
        `${medals[i] || `**${i + 1}.**`} **[${e.title}](${e.siteUrl})** — ${e.count} ${e.count === 1 ? 'vote' : 'votes'}`
    )
    .join('\n');

  const embed = new EmbedBuilder().setColor(0xffd700).setTitle('⭐ Most Recommended Anime').setDescription(lines);
  interaction.reply({ embeds: [embed] });
}

async function handleButton(interaction) {
  const guildId = interaction.guildId;
  if (!guildId) return;

  const [action, mediaIdStr] = interaction.customId.split('_');
  const mediaId = parseInt(mediaIdStr, 10);
  if (!mediaId) return;

  const data = loadData();
  const guildData = ensureGuildData(data, guildId);

  try {
    if (action === 'wl') {
      await handleWatchLaterButton(interaction, data, guildData, mediaId);
    } else if (action === 'rec') {
      await handleRecommendButton(interaction, data, guildData, mediaId);
    }
  } catch (err) {
    console.error('Error handling button interaction:', err);
    const payload = { content: 'Something went wrong. Try again in a bit.', ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload);
    } else {
      await interaction.reply(payload);
    }
  }
}

async function handleWatchLaterButton(interaction, data, guildData, mediaId) {
  const userId = interaction.user.id;
  if (!guildData.watchlist[userId]) guildData.watchlist[userId] = [];
  const list = guildData.watchlist[userId];
  const existingIndex = list.findIndex((e) => e.mediaId === mediaId);

  if (existingIndex !== -1) {
    list.splice(existingIndex, 1);
    saveData(data);
    await interaction.reply({ content: '🗑️ Removed from your watch later list.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const media = await getMediaById(mediaId).catch(() => null);
  if (!media) {
    await interaction.editReply("Couldn't reach AniList to save that. Try again in a bit.");
    return;
  }
  const title = media.title.english || media.title.romaji;
  list.push({ mediaId, title, siteUrl: media.siteUrl });
  saveData(data);
  await interaction.editReply(`📌 Added **${title}** to your watch later list.`);
}

async function handleRecommendButton(interaction, data, guildData, mediaId) {
  const userId = interaction.user.id;
  if (!guildData.recommendations[mediaId]) {
    guildData.recommendations[mediaId] = { title: null, siteUrl: null, recommendedBy: [] };
  }
  const rec = guildData.recommendations[mediaId];
  const alreadyRecommended = rec.recommendedBy.includes(userId);

  await interaction.deferReply({ ephemeral: true });

  if (alreadyRecommended) {
    rec.recommendedBy = rec.recommendedBy.filter((id) => id !== userId);
  } else {
    if (!rec.title) {
      const media = await getMediaById(mediaId).catch(() => null);
      if (media) {
        rec.title = media.title.english || media.title.romaji;
        rec.siteUrl = media.siteUrl;
      }
    }
    rec.recommendedBy.push(userId);
  }

  saveData(data);

  // Reflect the new count on the button itself, on the original message.
  try {
    const newRow = buildActivityButtons(mediaId, rec.recommendedBy.length);
    await interaction.message.edit({ components: [newRow] });
  } catch (e) {
    console.error('Failed to update recommend button count:', e.message);
  }

  await interaction.editReply(
    alreadyRecommended ? 'Removed your recommendation.' : 'Thanks for the recommendation! ⭐'
  );
}

function buildActivityButtons(mediaId, recommendCount = 0) {
  const watchLaterBtn = new ButtonBuilder()
    .setCustomId(`wl_${mediaId}`)
    .setLabel('Watch Later')
    .setEmoji('📌')
    .setStyle(ButtonStyle.Secondary);

  const recommendBtn = new ButtonBuilder()
    .setCustomId(`rec_${mediaId}`)
    .setLabel(recommendCount ? `Recommend • ${recommendCount}` : 'Recommend')
    .setEmoji('⭐')
    .setStyle(ButtonStyle.Success);

  return new ActionRowBuilder().addComponents(watchLaterBtn, recommendBtn);
}

function statusEmoji(status) {
  const s = (status || '').toLowerCase();
  if (s.includes('complet')) return '✅';
  if (s.includes('drop')) return '🗑️';
  if (s.includes('paus')) return '⏸️';
  if (s.includes('plan')) return '📌';
  if (s.includes('rewatch') || s.includes('reread')) return '🔁';
  if (s.includes('watch')) return '▶️';
  if (s.includes('read')) return '📖';
  return '📺';
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function stripMarkup(text) {
  return (text || '')
    .replace(/img\d*\(.*?\)/g, '')
    .replace(/webm\(.*?\)/g, '')
    .replace(/[_*~`]/g, '')
    .trim();
}

// Cleans AniList's plain-text media descriptions: drops leftover HTML tags
// and, importantly, strips ~!spoiler!~ tagged segments entirely so we never
// accidentally post spoilers into a public channel (Discord doesn't parse
// that AniList-specific spoiler syntax, so it would otherwise show in full).
function stripDescription(text) {
  if (!text) return '';
  return text
    .replace(/~!.*?!~/gs, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?(i|b|em|strong|p)>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text, max) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function buildEmbed(username, avatarUrl, activity) {
  const embed = new EmbedBuilder()
    .setTimestamp(new Date(activity.createdAt * 1000))
    .setFooter({ text: 'AniList' });

  const authorOpts = { name: `Profile ✦ ${username}`, url: `https://anilist.co/user/${username}` };
  if (avatarUrl) authorOpts.iconURL = avatarUrl;
  embed.setAuthor(authorOpts);

  if (activity.__typename === 'ListActivity') {
    const title = activity.media.title.english || activity.media.title.romaji;
    const displayImage =
      activity.media.coverImage.extraLarge || activity.media.coverImage.large || activity.media.coverImage.medium;
    const color = await getDominantColor(displayImage);
    const synopsis = truncate(stripDescription(activity.media.description), 280);
    const rawStatus = (activity.status || 'updated').toLowerCase();
    // Bold + linked + no underline only works inside the description field —
    // Discord always underlines a title that has a URL attached, with no way to turn that off.
    const statusLine = `*${rawStatus}* **[${title}](${activity.media.siteUrl})**`;

    embed
      .setColor(color)
      .setTitle(
        `${statusEmoji(activity.status)} ${capitalize(rawStatus)}${activity.progress ? ` ${activity.progress}` : ''}`
      )
      .setDescription(synopsis ? `${statusLine}\n\n${synopsis}` : statusLine)
      .setImage(displayImage);
  } else if (activity.__typename === 'TextActivity') {
    embed
      .setColor(DEFAULT_COLOR)
      .setTitle('💬 Posted a status update')
      .setDescription(truncate(stripMarkup(activity.text), 300))
      .setURL(activity.siteUrl);
  } else if (activity.__typename === 'MessageActivity') {
    embed
      .setColor(DEFAULT_COLOR)
      .setTitle('💬 Posted a message')
      .setDescription(truncate(stripMarkup(activity.message), 300))
      .setURL(activity.siteUrl);
  } else {
    embed.setColor(DEFAULT_COLOR).setTitle('📺 New AniList activity').setURL(`https://anilist.co/user/${username}`);
  }
  return embed;
}

async function pollAllGuilds() {
  const data = loadData();
  let changed = false;

  for (const guildId of Object.keys(data.guilds)) {
    const guildData = ensureGuildData(data, guildId);
    if (!guildData.channelId || !guildData.users.length) continue;

    const channel = await client.channels.fetch(guildData.channelId).catch(() => null);
    if (!channel) continue;

    for (const user of guildData.users) {
      try {
        const activities = await getRecentActivities(user.id, 10);
        const newOnes = activities.filter((a) => a.id > user.lastActivityId).sort((a, b) => a.id - b.id);

        for (const activity of newOnes) {
          const embed = await buildEmbed(user.username, user.avatar, activity);
          const content = user.addedBy ? `<@${user.addedBy}>` : undefined;
          const components =
            activity.__typename === 'ListActivity' ? [buildActivityButtons(activity.media.id, 0)] : [];

          await channel.send({
            content,
            embeds: [embed],
            components,
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