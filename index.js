require('dotenv').config();
const http = require('http');
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');
const { loadData, saveData } = require('./storage');
const { getUserByName, getRecentActivities, getMediaById, getUserFavorites } = require('./anilist');
const { getDominantColor, DEFAULT_COLOR } = require('./imageColor');

const POLL_INTERVAL_MS = (parseInt(process.env.POLL_MINUTES, 10) || 3) * 60 * 1000;
const ANIME_ROLE_NAME = 'anime'; // server role (case-insensitive) pinged on relaunch
const MAX_RECENT_POSTS = 300; // how many recent activity posts we remember per guild for reaction/recommend lookups

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

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions],
  partials: [Partials.Message, Partials.Reaction, Partials.Channel],
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  pollAllGuilds();
  setInterval(pollAllGuilds, POLL_INTERVAL_MS);
  notifyRelaunch();
});

// Makes sure a guild's data object has every field newer features need,
// even for guilds that were first tracked before those features existed.
function ensureGuildData(data, guildId) {
  if (!data.guilds[guildId]) {
    data.guilds[guildId] = { channelId: null, users: [], watchlist: {}, recommendations: {}, recentPosts: {} };
  }
  const guildData = data.guilds[guildId];
  if (!guildData.watchlist) guildData.watchlist = {};
  if (!guildData.recommendations) guildData.recommendations = {};
  if (!guildData.recentPosts) guildData.recentPosts = {};
  return guildData;
}

async function findAnimeRole(guild) {
  try {
    const roles = await guild.roles.fetch();
    return roles.find((r) => r.name.toLowerCase() === ANIME_ROLE_NAME) || null;
  } catch (e) {
    console.error(`Failed to fetch roles for guild ${guild.id}:`, e.message);
    return null;
  }
}

// Pings the @Anime role in every configured channel once on startup, so
// people know to re-track if a restart caused anything to look stale.
async function notifyRelaunch() {
  const data = loadData();
  for (const guildId of Object.keys(data.guilds)) {
    const guildData = ensureGuildData(data, guildId);
    if (!guildData.channelId) continue;

    try {
      const guild = await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) continue;
      const channel = await client.channels.fetch(guildData.channelId).catch(() => null);
      if (!channel) continue;

      const animeRole = await findAnimeRole(guild);
      if (!animeRole) continue; // no "Anime" role in this server, skip quietly

      await channel.send({
        content: `<@&${animeRole.id}> 🔄 AniTracker just restarted. If your activity feed looks stale, you may want to re-run \`/track\` for your profile.`,
        allowedMentions: { roles: [animeRole.id] },
      });
    } catch (e) {
      console.error(`Failed to send relaunch notice for guild ${guildId}:`, e.message);
    }
  }
}

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    await handleSlashCommand(interaction);
  } else if (interaction.isButton()) {
    await handleButton(interaction);
  }
});

// DMs the tracked profile's owner when someone reacts to their activity
// post, and DMs the reactor a private confirmation that it happened.
// Ignores reactions from any bot (covers an auto-reacter bot and similar).
client.on('messageReactionAdd', async (reaction, reactingUser) => {
  try {
    if (reactingUser.bot) return;

    if (reaction.partial) {
      const fetched = await reaction.fetch().catch(() => null);
      if (!fetched) return;
      reaction = fetched;
    }

    const message = reaction.message.partial ? await reaction.message.fetch().catch(() => null) : reaction.message;
    if (!message || !message.guild || message.author?.id !== client.user.id) return;

    const data = loadData();
    const guildData = ensureGuildData(data, message.guild.id);
    const postInfo = guildData.recentPosts[message.id];
    if (!postInfo || !postInfo.addedBy) return;
    if (reactingUser.id === postInfo.addedBy) return; // don't notify people about their own reaction

    const emojiStr = reaction.emoji.toString();
    const animeTitle = postInfo.animeTitle || 'their activity';

    // Private DM to the profile owner: who reacted and to what.
    try {
      const owner = await client.users.fetch(postInfo.addedBy);
      await owner.send({
        content: `<@${reactingUser.id}> reacted ${emojiStr} to you watching **${animeTitle}**.`,
        allowedMentions: { parse: [] },
      });
    } catch (e) {
      console.error(`Failed to DM profile owner ${postInfo.addedBy}:`, e.message);
    }

    // Private DM to the reactor: confirms the alert went out, nobody else sees this.
    try {
      await reactingUser.send({
        content: `<@${postInfo.addedBy}> was alerted of your reaction ${emojiStr} to **${animeTitle}**.`,
        allowedMentions: { parse: [] },
      });
    } catch (e) {
      console.error(`Failed to DM reactor ${reactingUser.id}:`, e.message);
    }
  } catch (e) {
    console.error('Error handling reaction notification:', e.message);
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
    } else if (commandName === 'favorites') {
      await handleFavorites(interaction);
    } else if (commandName === 'whostracking') {
      await handleWhosTracking(interaction, guildData);
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
    `✅ Now tracking **${user.name}**'s AniList activity. New updates will post in <#${guildData.channelId}> and quietly ping <@${interaction.user.id}>.`
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

// Same info as /list but with plain Discord display names instead of
// mentions, so running it never pings anyone.
async function handleWhosTracking(interaction, guildData) {
  if (!guildData.users.length) {
    await interaction.reply('Not tracking any AniList profiles yet.');
    return;
  }

  const lines = await Promise.all(
    guildData.users.map(async (u) => {
      let trackerName = 'unknown';
      if (u.addedBy) {
        const member = await interaction.guild.members.fetch(u.addedBy).catch(() => null);
        trackerName = member ? member.displayName : 'unknown';
      }
      return `• **${u.username}** — tracked by ${trackerName}`;
    })
  );

  await interaction.reply(`📋 Who's Tracking What\n${lines.join('\n')}`);
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

async function handleFavorites(interaction) {
  const username = interaction.options.getString('username');
  await interaction.deferReply();

  const user = await getUserFavorites(username).catch(() => null);
  if (!user) {
    await interaction.editReply(`Couldn't find an AniList user named **${username}**.`);
    return;
  }

  const animeList = user.favourites?.anime?.nodes || [];
  const mangaList = user.favourites?.manga?.nodes || [];

  if (!animeList.length && !mangaList.length) {
    await interaction.editReply(`**${user.name}** hasn't favorited anything on AniList yet.`);
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(DEFAULT_COLOR)
    .setTitle(`💖 ${user.name}'s Favorites`)
    .setURL(user.siteUrl);

  if (animeList.length) {
    embed.addFields({
      name: '📺 Anime',
      value: animeList
        .map((m) => `• [${m.title.english || m.title.romaji}](${m.siteUrl})`)
        .join('\n')
        .slice(0, 1024),
    });
  }
  if (mangaList.length) {
    embed.addFields({
      name: '📖 Manga',
      value: mangaList
        .map((m) => `• [${m.title.english || m.title.romaji}](${m.siteUrl})`)
        .join('\n')
        .slice(0, 1024),
    });
  }

  await interaction.editReply({ embeds: [embed] });
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

  // Reflect the new count on the button AND the "Recommended by N people" footer line.
  try {
    const newCount = rec.recommendedBy.length;
    const newRow = buildActivityButtons(mediaId, newCount);
    const existingEmbed = interaction.message.embeds[0];
    const editPayload = { components: [newRow] };
    if (existingEmbed) {
      editPayload.embeds = [EmbedBuilder.from(existingEmbed).setFooter({ text: buildFooterText(newCount) })];
    }
    await interaction.message.edit(editPayload);
  } catch (e) {
    console.error('Failed to update recommend display:', e.message);
  }

  // DM whoever's activity this was, telling them who recommended it — but only on a fresh recommend, not a removal.
  if (!alreadyRecommended) {
    try {
      const postInfo = guildData.recentPosts[interaction.message.id];
      if (postInfo && postInfo.addedBy && postInfo.addedBy !== userId) {
        const owner = await client.users.fetch(postInfo.addedBy);
        const animeName = rec.title || 'an anime';
        await owner.send({
          content: `<@${userId}> recommended **${animeName}** that you were watching!`,
          allowedMentions: { parse: [] },
        });
      }
    } catch (e) {
      console.error('Failed to DM recommend notification:', e.message);
    }
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

// Only mentions the recommend count when there's actually at least one — an
// empty "Recommended by 0 people" line would just be clutter.
function buildFooterText(recommendCount) {
  if (recommendCount > 0) {
    return `Recommended by ${recommendCount} ${recommendCount === 1 ? 'person' : 'people'} • AniList`;
  }
  return 'AniList';
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

// A clean, standalone verb for the small lead-in line — independent of
// AniList's raw status phrasing, so it combines predictably with our own
// "Season X, Episode Y" wording instead of risking duplicate words like
// "watched episode Episode 5".
function statusVerbShort(status) {
  const s = (status || '').toLowerCase();
  if (s.includes('complet')) return 'Completed';
  if (s.includes('drop')) return 'Dropped';
  if (s.includes('paus')) return 'Paused';
  if (s.includes('plan')) return 'Plans to watch';
  if (s.includes('rewatch')) return 'Rewatched';
  if (s.includes('reread')) return 'Reread';
  if (s.includes('watch')) return 'Watched';
  if (s.includes('read')) return 'Read';
  return capitalize(s) || 'Updated';
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Best-effort split of a trailing season indicator off the base title, e.g.
// "Konosuba 3" -> { baseTitle: "Konosuba", season: 3 }. AniList has no
// structured season field, so this is pattern-matching against the title
// text itself — it'll catch the common naming styles but won't be perfect
// for every show, especially ones whose real title just happens to end in
// a number (e.g. "86", "91 Days").
function splitTitleAndSeason(rawTitle) {
  const namedPatterns = [
    /^(.*?)\s+(\d+)(?:st|nd|rd|th)\s+Season$/i,
    /^(.*?)\s+Season\s+(\d+)$/i,
    /^(.*?)\s+Part\s+(\d+)$/i,
  ];
  for (const pattern of namedPatterns) {
    const m = rawTitle.match(pattern);
    if (m) return { baseTitle: m[1].trim(), season: parseInt(m[2], 10) };
  }

  const romanMap = { II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };
  const romanMatch = rawTitle.match(/^(.*?)\s+(II|III|IV|V|VI|VII|VIII|IX|X)$/);
  if (romanMatch && romanMap[romanMatch[2]]) {
    return { baseTitle: romanMatch[1].trim(), season: romanMap[romanMatch[2]] };
  }

  // Bare trailing number, e.g. "Kaguya-sama wa Kokurasetai 3" — only treated
  // as a season if it's a small number, to avoid misfiring on titles like "86".
  const bareMatch = rawTitle.match(/^(.*?)\s+(\d{1,2})$/);
  if (bareMatch && parseInt(bareMatch[2], 10) <= 9 && bareMatch[1].trim().length > 2) {
    return { baseTitle: bareMatch[1].trim(), season: parseInt(bareMatch[2], 10) };
  }

  return { baseTitle: rawTitle, season: null };
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

async function buildEmbed(username, avatarUrl, activity, streak) {
  const embed = new EmbedBuilder().setTimestamp(new Date(activity.createdAt * 1000));

  if (activity.__typename === 'ListActivity') {
    const rawTitle = activity.media.title.english || activity.media.title.romaji;
    const { baseTitle, season } = splitTitleAndSeason(rawTitle);

    // Author renders smaller/muted by Discord's own default styling — no
    // markdown needed — which is the only way to get genuinely small text
    // ABOVE the title. So the "Watched Episode 5 of:" lead-in lives here.
    const subParts = [];
    if (season) subParts.push(`Season ${season}`);
    if (activity.progress) subParts.push(`Episode ${activity.progress}`);
    const progressSuffix = subParts.join(', ');
    const leadInText = progressSuffix
      ? `${statusEmoji(activity.status)} ${statusVerbShort(activity.status)} ${progressSuffix} of:`
      : `${statusEmoji(activity.status)} ${statusVerbShort(activity.status)}:`;
    const authorOpts = { name: leadInText };
    if (avatarUrl) authorOpts.iconURL = avatarUrl;
    embed.setAuthor(authorOpts);

    // Title holds ONLY the anime name, linked, full size — nothing else.
    embed.setTitle(baseTitle).setURL(activity.media.siteUrl);

    // Back to the portrait cover art (largest AniList provides — there's no
    // size above "extraLarge" to request, so this is already maxed out).
    const displayImage =
      activity.media.coverImage.extraLarge || activity.media.coverImage.large || activity.media.coverImage.medium;
    const color = await getDominantColor(displayImage);

    const infoBits = [];
    if (typeof activity.media.averageScore === 'number' && activity.media.averageScore !== null) {
      infoBits.push(`⭐ ${(activity.media.averageScore / 10).toFixed(1)}/10`);
    }
    if (activity.media.genres && activity.media.genres.length) {
      infoBits.push(`🎭 ${activity.media.genres.slice(0, 3).join(', ')}`);
    }
    if (activity.media.isAdult) infoBits.push('🔞 18+');
    const infoLine = infoBits.join('  •  ');

    const synopsis = truncate(stripDescription(activity.media.description), 160);

    const descParts = [`✦ ${username}  •  🔥 ${streak || 1}`];
    if (infoLine) descParts.push(infoLine);
    if (synopsis) descParts.push(synopsis);
    embed.setDescription(descParts.join('\n\n'));

    embed
      .setColor(color)
      .setImage(displayImage)
      .setFooter({ text: buildFooterText(0) }); // fresh post, nobody's recommended it yet
  } else {
    if (avatarUrl) embed.setAuthor({ name: '\u200b', iconURL: avatarUrl });
    const profileLine = `✦ ${username}  •  🔥 ${streak || 1}`;

    if (activity.__typename === 'TextActivity') {
      embed
        .setColor(DEFAULT_COLOR)
        .setTitle('💬 Posted a status update')
        .setURL(activity.siteUrl)
        .setDescription(`${profileLine}\n\n${truncate(stripMarkup(activity.text), 300)}`)
        .setFooter({ text: 'AniList' });
    } else if (activity.__typename === 'MessageActivity') {
      embed
        .setColor(DEFAULT_COLOR)
        .setTitle('💬 Posted a message')
        .setURL(activity.siteUrl)
        .setDescription(`${profileLine}\n\n${truncate(stripMarkup(activity.message), 300)}`)
        .setFooter({ text: 'AniList' });
    } else {
      embed
        .setColor(DEFAULT_COLOR)
        .setTitle('📺 New AniList activity')
        .setURL(`https://anilist.co/user/${username}`)
        .setDescription(profileLine)
        .setFooter({ text: 'AniList' });
    }
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

        // Daily streak: counts up if there was activity yesterday and today,
        // resets to 1 if a day was skipped. Computed once per poll batch
        // (not per activity) so multiple updates in one day don't double-count.
        if (newOnes.length) {
          const today = new Date().toISOString().slice(0, 10);
          if (user.lastActivityDate !== today) {
            const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
            user.streak = user.lastActivityDate === yesterday ? (user.streak || 0) + 1 : 1;
            user.lastActivityDate = today;
          }
        }

        for (const activity of newOnes) {
          const embed = await buildEmbed(user.username, user.avatar, activity, user.streak);
          const content = user.addedBy ? `<@${user.addedBy}>` : undefined;
          const components =
            activity.__typename === 'ListActivity' ? [buildActivityButtons(activity.media.id, 0)] : [];

          const sentMessage = await channel.send({
            content,
            embeds: [embed],
            components,
            allowedMentions: user.addedBy ? { users: [user.addedBy] } : undefined,
            // Ping quietly: shows normally in the channel, but doesn't trigger
            // a push notification/sound for the mentioned tracker.
            flags: user.addedBy ? MessageFlags.SuppressNotifications : undefined,
          });

          // Remember this post so a later reaction/recommend can be traced back to who to notify.
          guildData.recentPosts[sentMessage.id] = {
            addedBy: user.addedBy || null,
            animeTitle:
              activity.__typename === 'ListActivity'
                ? activity.media.title.english || activity.media.title.romaji
                : null,
          };
          changed = true;
        }

        if (newOnes.length) {
          user.lastActivityId = Math.max(...newOnes.map((a) => a.id));
          changed = true;
        }
      } catch (e) {
        console.error(`Failed polling ${user.username}:`, e.message);
      }
    }

    // Keep recentPosts from growing forever. Discord message IDs are
    // snowflakes (roughly chronological, all-digit), so sorted key order
    // here is effectively oldest-to-newest — trimming the front removes
    // the oldest entries.
    const postKeys = Object.keys(guildData.recentPosts);
    if (postKeys.length > MAX_RECENT_POSTS) {
      const excess = postKeys.length - MAX_RECENT_POSTS;
      for (let i = 0; i < excess; i++) delete guildData.recentPosts[postKeys[i]];
      changed = true;
    }
  }

  if (changed) saveData(data);
}

client.login(process.env.DISCORD_TOKEN);
