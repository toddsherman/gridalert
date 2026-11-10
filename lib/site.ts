/**
 * GridAlert is served at todd.sh/gridalert: todd.sh proxies this path to the Vercel project,
 * which builds with the same basePath so its pages and assets line up on both hosts.
 */
export const BASE_PATH = '/gridalert';

/** Where people reach it, for links in alerts. */
export const PUBLIC_URL = `https://www.todd.sh${BASE_PATH}`;
