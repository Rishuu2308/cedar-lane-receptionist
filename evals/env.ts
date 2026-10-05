/**
 * Evals always run on the in-memory stores with the default shop settings, whatever
 * is in a local .env. Imported first so it takes effect before the config is read.
 */
Object.assign(process.env, {
  STORE: 'memory',
  SHOP_TIMEZONE: 'America/Los_Angeles',
  SHOP_BAYS: '1',
  DEFAULT_COUNTRY_CODE: '1',
});
