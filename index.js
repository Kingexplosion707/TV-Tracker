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
const {
  getUserByName,
  getRecentActivities,
  getMediaById,
  getUserFavorites,
  getMediaRelations,
} = require('./anilist');
const { getDominantColor, DEFAULT_COLOR } = require('./imageColor');

const POLL_INTERVAL_MS = (parseInt(process.env.POLL_MINUTES, 10) || 3) * 60 * 1000;
const ANIME_ROLE_NAME = 'anime'; // server role (case-insensitive) pinged on relaunch
const MAX_RECENT_POSTS = 300; // how many recent activity posts we remember per guild for reaction/recommend lookups
const MAX_SEASON_HOPS = 5; // safety cap on how far back we'll walk a prequel chain

// In-memory cache of mediaId -> resolved season/root info, so we only ever
// walk a given show's prequel chain once per bot process lifetime.
const seasonCache = new Map();

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
    data.guilds[guildId] = {
      channelId: null,
      users: [],
      watchlist: {},
      favorites: {},
      recommendations: {},
      recentPosts: {},
    };
  }
  const guildData = data.guilds[guildId];
  if (!guildData.watchlist) guildData.watchlist = {};
  if (!guildData.favorites) guildData.favorites = {};
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
  const data = await loadData();
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

    const data = await loadData();
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

  const data = await loadData();
  const guildData = ensureGuildData(data, guildId);

  try {
    if (commandName === 'track') {
      await handleTrack(interaction, data, guildData);
    } else if (commandName === 'untrack') {
      await handleUntrack(interaction, data, guildData);
    } else if (commandName === 'list') {
      handleList(interaction, guildData);
    } else if (commandName === 'setchannel') {
      await handleSetChannel(interaction, data, guildData);
    } else if (commandName === 'watchlater') {
      handleWatchLaterList(interaction, guildData);
    } else if (commandName === 'myfavorites') {
      handleMyFavorites(interaction, guildData);
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
  await saveData(data);

  await interaction.editReply(
    `✅ Now tracking **${user.name}**'s AniList activity. New updates will post in <#${guildData.channelId}> and quietly ping <@${interaction.user.id}>.`
  );
}

async function handleUntrack(interaction, data, guildData) {
  const username = interaction.options.getString('username');
  const before = guildData.users.length;
  guildData.users = guildData.users.filter((u) => u.username.toLowerCase() !== username.toLowerCase());
  await saveData(data);

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

async function handleSetChannel(interaction, data, guildData) {
  if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
    interaction.reply({ content: 'You need the Manage Server permission to do that.', ephemeral: true });
    return;
  }
  const channel = interaction.options.getChannel('channel');
  guildData.channelId = channel.id;
  await saveData(data);
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

// Bot-local favorites — saved in AniTracker's own storage only, NOT synced
// to the person's real AniList account favorites (that would need OAuth).
function handleMyFavorites(interaction, guildData) {
  const list = guildData.favorites[interaction.user.id] || [];
  if (!list.length) {
    interaction.reply({
      content:
        'Your favorites list is empty. Click ❤️ **Favorite** on any activity to add one! (Saved in the bot — not synced to your real AniList favorites.)',
      ephemeral: true,
    });
    return;
  }
  const lines = list.map((e, i) => `${i + 1}. **[${e.title}](${e.siteUrl})**`).join('\n');
  const embed = new EmbedBuilder()
    .setColor(DEFAULT_COLOR)
    .setTitle('❤️ Your Favorites (saved in the bot)')
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

  const data = await loadData();
  const guildData = ensureGuildData(data, guildId);

  try {
    if (action === 'wl') {
      await handleWatchLaterButton(interaction, data, guildData, mediaId);
    } else if (action === 'rec') {
      await handleRecommendButton(interaction, data, guildData, mediaId);
    } else if (action === 'fav') {
      await handleFavoriteButton(interaction, data, guildData, mediaId);
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
    await saveData(data);
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
  await saveData(data);
  await interaction.editReply(`📌 Added **${title}** to your watch later list.`);
}

// Bot-local favorite toggle — mirrors Watch Later exactly, separate storage.
async function handleFavoriteButton(interaction, data, guildData, mediaId) {
  const userId = interaction.user.id;
  if (!guildData.favorites[userId]) guildData.favorites[userId] = [];
  const list = guildData.favorites[userId];
  const existingIndex = list.findIndex((e) => e.mediaId === mediaId);

  if (existingIndex !== -1) {
    list.splice(existingIndex, 1);
    await saveData(data);
    await interaction.reply({ content: '💔 Removed from your favorites.', ephemeral: true });
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
  await saveData(data);
  await interaction.editReply(
    `❤️ Added **${title}** to your favorites. (Saved in the bot — not synced to your real AniList favorites.)`
  );
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

  await saveData(data);

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

  const favoriteBtn = new ButtonBuilder()
    .setCustomId(`fav_${mediaId}`)
    .setLabel('Favorite')
    .setEmoji('❤️')
    .setStyle(ButtonStyle.Danger);

  const recommendBtn = new ButtonBuilder()
    .setCustomId(`rec_${mediaId}`)
    .setLabel(recommendCount ? `Recommend • ${recommendCount}` : 'Recommend')
    .setEmoji('⭐')
    .setStyle(ButtonStyle.Success);

  return new ActionRowBuilder().addComponents(watchLaterBtn, favoriteBtn, recommendBtn);
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

// A clean, standalone verb for the caption line — independent of AniList's
// raw status phrasing, so it combines predictably with our own
// "season X, episode Y" wording.
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

// Pulls "#N Most Popular All Time" from a Media's rankings array, only
// returning it if N <= 100 (anything past that isn't worth showing).
function getPopularityRank(rankings) {
  if (!rankings) return null;
  const entry = rankings.find((r) => r.type === 'POPULAR' && r.allTime);
  if (!entry || entry.rank > 100) return null;
  return entry.rank;
}

// Walks AniList's actual PREQUEL relation chain to find the true root entry
// of a franchise (e.g. Season 1) — correct even when each season has a
// completely different title, unlike guessing from title text. Everywhere
// downstream (embed title, Watch Later, Recommend, buttons) uses this root
// identity, so different seasons of the same show consolidate into one
// consistent entry instead of being tracked separately. Capped at
// MAX_SEASON_HOPS API calls per uncached show, and cached in-memory
// afterward so a show's info is only ever resolved once per bot uptime.
async function resolveSeasonInfo(mediaId, fallbackTitle, fallbackSiteUrl) {
  if (seasonCache.has(mediaId)) return seasonCache.get(mediaId);

  let season = 1;
  let rootId = mediaId;
  let rootTitle = fallbackTitle;
  let rootSiteUrl = fallbackSiteUrl;
  let rootRankings = null;

  let cursorId = mediaId;
  for (let hop = 0; hop < MAX_SEASON_HOPS; hop++) {
    const media = await getMediaRelations(cursorId).catch(() => null);
    if (!media) break;
    if (hop === 0) rootRankings = media.rankings || null; // in case this entry turns out to already be the root

    const edges = media.relations?.edges;
    if (!edges) break;
    const prequel = edges.find((e) => e.relationType === 'PREQUEL');
    if (!prequel) break;

    season += 1;
    rootId = prequel.node.id;
    rootTitle = prequel.node.title?.english || prequel.node.title?.romaji || rootTitle;
    rootSiteUrl = prequel.node.siteUrl || rootSiteUrl;
    rootRankings = prequel.node.rankings || null;
    cursorId = prequel.node.id;
  }

  const result = {
    season: season > 1 ? season : null,
    rootId,
    rootTitle,
    rootSiteUrl,
    popularityRank: getPopularityRank(rootRankings),
  };
  seasonCache.set(mediaId, result);
  return result;
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

async function buildEmbed(username, avatarUrl, activity, streak, seasonInfo) {
  const embed = new EmbedBuilder().setTimestamp(new Date(activity.createdAt * 1000));

  // Author's url applies to its ENTIRE name text as one clickable unit —
  // there's no way to link just the username and exclude the streak from
  // that click region within a single field. Keeping them together here is
  // also the only way to have the streak appear on the same row as the
  // avatar icon, since that icon only exists in the Author field.
  const authorOpts = {
    name: `✦ ${username}   🔥 ${streak || 1}`,
    url: `https://anilist.co/user/${username}`,
  };
  if (avatarUrl) authorOpts.iconURL = avatarUrl;
  embed.setAuthor(authorOpts);

  if (activity.__typename === 'ListActivity') {
    const { season, rootTitle, rootSiteUrl, popularityRank } = seasonInfo;

    const subParts = [];
    if (season) subParts.push(`season ${season}`);
    if (activity.progress) subParts.push(`episode ${activity.progress}`);
    const progressSuffix = subParts.join(', ');
    const captionLine = progressSuffix
      ? `${statusVerbShort(activity.status)} ${progressSuffix} ${statusEmoji(activity.status)}`
      : `${statusVerbShort(activity.status)} ${statusEmoji(activity.status)}`;

    // "# " header markdown renders bigger than embed Title styling and,
    // unlike Title, supports being a link without forcing an underline.
    // Uses the resolved ROOT title/link (e.g. always "Attack on Titan"),
    // not this specific season's own AniList title/page.
    const headerLine = `# [${rootTitle}](${rootSiteUrl})`;

    // Portrait cover art — already the largest size AniList provides
    // ("extraLarge"). Worth noting: even a genuinely higher-resolution
    // source wouldn't render any bigger in Discord, since Discord caps the
    // embed image's display width itself regardless of the source file's
    // resolution — the platform, not the source, is the real ceiling here.
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
    if (activity.media.isAdult) infoBits.push('🔞 Mature');
    if (popularityRank) infoBits.push(`🌍 #${popularityRank} Most Popular`);
    const infoLine = infoBits.join('  •  ');

    const synopsis = truncate(stripDescription(activity.media.description), 160);

    const descParts = [`${captionLine}\n${headerLine}`];
    if (infoLine) descParts.push(infoLine);
    if (synopsis) descParts.push(synopsis);
    embed.setDescription(descParts.join('\n\n'));

    embed
      .setColor(color)
      .setImage(displayImage)
      .setFooter({ text: buildFooterText(0) }); // fresh post, nobody's recommended it yet
  } else if (activity.__typename === 'TextActivity') {
    embed
      .setColor(DEFAULT_COLOR)
      .setTitle('💬 Posted a status update')
      .setURL(activity.siteUrl)
      .setDescription(truncate(stripMarkup(activity.text), 300))
      .setFooter({ text: 'AniList' });
  } else if (activity.__typename === 'MessageActivity') {
    embed
      .setColor(DEFAULT_COLOR)
      .setTitle('💬 Posted a message')
      .setURL(activity.siteUrl)
      .setDescription(truncate(stripMarkup(activity.message), 300))
      .setFooter({ text: 'AniList' });
  } else {
    embed
      .setColor(DEFAULT_COLOR)
      .setTitle('📺 New AniList activity')
      .setURL(`https://anilist.co/user/${username}`)
      .setFooter({ text: 'AniList' });
  }
  return embed;
}

async function pollAllGuilds() {
  const data = await loadData();
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
          let seasonInfo = null;
          if (activity.__typename === 'ListActivity') {
            const fallbackTitle = activity.media.title.english || activity.media.title.romaji;
            seasonInfo = await resolveSeasonInfo(activity.media.id, fallbackTitle, activity.media.siteUrl);
          }

          const embed = await buildEmbed(user.username, user.avatar, activity, user.streak, seasonInfo);
          const content = user.addedBy ? `<@${user.addedBy}>` : undefined;
          const components = seasonInfo ? [buildActivityButtons(seasonInfo.rootId, 0)] : [];

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
            animeTitle: seasonInfo ? seasonInfo.rootTitle : null,
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

  if (changed) await saveData(data);
}

client.login(process.env.DISCORD_TOKEN);
