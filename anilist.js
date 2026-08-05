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
              title { romaji english }
              siteUrl
              coverImage { large medium }
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

module.exports = { getUserByName, getRecentActivities };
