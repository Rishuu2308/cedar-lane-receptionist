/**
 * Evals always run on the in-memory stores with the default shop settings, whatever
 * is in a local .env. Imported first so it takes effect before the config is read.
 */
Object.assign(process.env, {
  // These four stay as set here even if .env says otherwise.
  CONFIG_LOCKED_KEYS: 'STORE,SHOP_TIMEZONE,SHOP_BAYS,DEFAULT_COUNTRY_CODE',
  STORE: 'memory',
  SHOP_TIMEZONE: 'America/Los_Angeles',
  SHOP_BAYS: '1',
  DEFAULT_COUNTRY_CODE: '1',
});
