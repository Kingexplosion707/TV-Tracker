const ANILIST_API = 'https://graphql.anilist.co';

async function anilistQuery(query, variables) {
  const res = await fetch(ANILIST_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`AniList API error ${res.status}: ${text}`);
  }

  const json = await res.json();
  if (json.errors) {
    throw new Error(`AniList API returned errors: ${JSON.stringify(json.errors)}`);
  }
  return json;
}

async function getUserByName(name) {
  const query = `
    query ($name: String) {
      User(name: $name) {
        id
        name
        siteUrl
        avatar { medium }
      }
    }`;
  const data = await anilistQuery(query, { name });
  return data.data.User;
}

async function getRecentActivities(userId, perPage = 10) {
  const query = `
    query ($userId: Int, $perPage: Int) {
      Page(page: 1, perPage: $perPage) {
        activities(userId: $userId, sort: ID_DESC) {
          __typename
          ... on ListActivity {
            id
            status
            progress
            createdAt
            media {
              id
              title { romaji english }
              siteUrl
              description(asHtml: false)
              coverImage { extraLarge large medium }
              bannerImage
              averageScore
              genres
              isAdult
              type
            }
          }
          ... on TextActivity {
            id
            text
            createdAt
            siteUrl
          }
          ... on MessageActivity {
            id
            message
            createdAt
            siteUrl
          }
        }
      }
    }`;
  const data = await anilistQuery(query, { userId, perPage });
  return data.data.Page.activities;
}

async function getMediaById(id) {
  const query = `
    query ($id: Int) {
      Media(id: $id) {
        id
        title { romaji english }
        siteUrl
      }
    }`;
  const data = await anilistQuery(query, { id });
  return data.data.Media;
}

async function getUserFavorites(name) {
  const query = `
    query ($name: String) {
      User(name: $name) {
        id
        name
        siteUrl
        favourites {
          anime(perPage: 10) {
            nodes { title { romaji english } siteUrl }
          }
          manga(perPage: 10) {
            nodes { title { romaji english } siteUrl }
          }
        }
      }
    }`;
  const data = await anilistQuery(query, { name });
  return data.data.User;
}

async function getMediaRelations(id) {
  const query = `
    query ($id: Int) {
      Media(id: $id) {
        id
        relations {
          edges {
            relationType
            node { id type }
          }
        }
      }
    }`;
  const data = await anilistQuery(query, { id });
  return data.data.Media;
}

module.exports = { getUserByName, getRecentActivities, getMediaById, getUserFavorites, getMediaRelations };
