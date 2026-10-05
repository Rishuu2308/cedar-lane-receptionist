import { GoogleCalendar } from '../calendar/google.js';
import { config } from '../config.js';
import { SHOP, setShopTimezone } from '../shop.js';

/**
 * Decide the shop timezone before anything is scheduled.
 * An explicit SHOP_TIMEZONE always wins. Otherwise, with Google configured, use the
 * calendar's own timezone so spoken times and the calendar view agree.
 */
export async function resolveShopTimezone(calendar?: GoogleCalendar): Promise<{ zone: string; source: string }> {
  if (config.shopTimezone) return { zone: SHOP.timezone, source: 'SHOP_TIMEZONE' };
  if (config.store !== 'google' && !calendar) return { zone: SHOP.timezone, source: 'default' };
  const cal = calendar ?? new GoogleCalendar(config.googleCalendarId);
  const zone = await cal.getTimeZone();
  if (zone) {
    setShopTimezone(zone);
    return { zone, source: 'Google Calendar setting' };
  }
  return { zone: SHOP.timezone, source: 'default' };
}
