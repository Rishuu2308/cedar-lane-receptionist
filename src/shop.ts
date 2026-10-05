/**
 * Everything the receptionist is allowed to say about the shop lives in this file.
 *
 * The assignment brief does not specify services, prices, hours or policies, so the
 * values below are invented but self-consistent. They are the single source of truth:
 * the system prompt is generated from them and the scheduling code enforces them, so
 * the agent cannot quote an hour or a duration that the booking logic disagrees with.
 */
import { IANAZone } from 'luxon';
import { config } from './config.js';

export type ServiceId = 'express_wash' | 'interior_detail_wash' | 'exterior_detail' | 'full_detail';
export type VehicleSize = 'car' | 'suv' | 'large';

export interface Service {
  id: ServiceId;
  name: string;
  /** Words callers use for this service; also used to recognise hand-made calendar events. */
  aliases: string[];
  durationMinutes: number;
  /** Whole-dollar prices by vehicle size. */
  prices: Record<VehicleSize, number>;
  includes: string;
}

export const SERVICES: Service[] = [
  {
    id: 'express_wash',
    name: 'Express Wash',
    aliases: ['express wash', 'wash', 'hand wash', 'exterior wash', 'quick wash'],
    durationMinutes: 30,
    prices: { car: 35, suv: 45, large: 55 },
    includes: 'exterior hand wash, wheels and tires, windows, towel dry',
  },
  {
    id: 'interior_detail_wash',
    name: 'Interior Detail & Wash',
    aliases: ['interior detail and wash', 'interior detail', 'interior', 'inside detail', 'interior clean'],
    durationMinutes: 60,
    prices: { car: 120, suv: 140, large: 160 },
    includes:
      'full vacuum, wipe-down and conditioning of dash, console, doors and seats, interior glass, door jambs, plus an exterior hand wash',
  },
  {
    id: 'exterior_detail',
    name: 'Exterior Detail',
    aliases: ['exterior detail', 'wash and wax', 'wax', 'clay and wax', 'outside detail'],
    durationMinutes: 60,
    prices: { car: 130, suv: 150, large: 170 },
    includes: 'hand wash, clay bar decontamination, machine-applied wax, wheels cleaned and tires dressed',
  },
  {
    id: 'full_detail',
    name: 'Full Detail',
    aliases: ['full detail', 'complete detail', 'inside and out', 'interior and exterior', 'the works'],
    durationMinutes: 150,
    prices: { car: 230, suv: 270, large: 310 },
    includes: 'everything in the Interior Detail & Wash and the Exterior Detail',
  },
];

export const SERVICE_IDS = SERVICES.map((s) => s.id) as [ServiceId, ...ServiceId[]];

export function getService(id: string): Service | undefined {
  return SERVICES.find((s) => s.id === id);
}

/** Best-effort match of free text (e.g. a hand-made calendar event title) to a service. */
export function inferService(text: string): Service | undefined {
  const t = text.toLowerCase().replace(/&/g, 'and');
  // Longest alias first so "interior detail and wash" beats "wash".
  const candidates = SERVICES.flatMap((s) =>
    [s.name.toLowerCase().replace(/&/g, 'and'), ...s.aliases].map((a) => ({ a, s })),
  ).sort((x, y) => y.a.length - x.a.length);
  return candidates.find((c) => t.includes(c.a))?.s;
}

export const VEHICLE_SIZES: Record<VehicleSize, string> = {
  car: 'sedans, coupes, hatchbacks and wagons',
  suv: 'two-row SUVs, crossovers and mid-size pickups',
  large: 'three-row SUVs, minivans and full-size pickups',
};

export const ADD_ONS: { name: string; price: number }[] = [
  { name: 'Pet hair removal', price: 40 },
  { name: 'Engine bay cleaning', price: 50 },
  { name: 'Headlight restoration (pair)', price: 60 },
  { name: 'Odor treatment', price: 70 },
];

/** Opening hours by Luxon weekday (1 = Monday ... 7 = Sunday). null = closed. */
export const HOURS: Record<number, { open: string; close: string } | null> = {
  1: { open: '08:00', close: '18:00' },
  2: { open: '08:00', close: '18:00' },
  3: { open: '08:00', close: '18:00' },
  4: { open: '08:00', close: '18:00' },
  5: { open: '08:00', close: '18:00' },
  6: { open: '09:00', close: '16:00' },
  7: null,
};

const DEFAULT_TIMEZONE = 'America/Los_Angeles';
let shopTimezone = config.shopTimezone || DEFAULT_TIMEZONE;
if (!IANAZone.isValidZone(shopTimezone)) {
  throw new Error(`SHOP_TIMEZONE "${shopTimezone}" is not a valid IANA timezone (example: America/Los_Angeles).`);
}

/**
 * All times the agent hears and says are in this timezone. When SHOP_TIMEZONE is not
 * set, the server adopts the Google Calendar's own timezone at startup so that
 * "4:30 PM" on a call is 4:30 PM when you look at the calendar.
 */
export function setShopTimezone(zone: string): void {
  if (!IANAZone.isValidZone(zone)) throw new Error(`"${zone}" is not a valid IANA timezone.`);
  shopTimezone = zone;
}

export const SHOP = {
  name: 'Cedar Lane Auto Detailing',
  agentName: 'Riley',
  address: '214 Cedar Lane',
  get timezone(): string {
    return shopTimezone;
  },
  /** Appointments start on this grid (minutes past the hour: 00 and 30). */
  slotMinutes: 30,
  /** How many vehicles can be worked on at once. */
  bays: config.shopBays,
  /** Earliest bookable start is this many minutes from now. */
  minLeadMinutes: 30,
  /** How far ahead callers can book. */
  bookingHorizonDays: 60,
  /** Arriving up to this late keeps the appointment as booked. */
  lateGraceMinutes: 15,
  /** Promise made to callers when something is handed to a person. */
  callbackPromise: 'by the end of the next business day',

  vehiclesWeDetail: 'sedans, coupes, hatchbacks, wagons, SUVs, crossovers, pickup trucks and minivans, including hybrids and EVs',
  vehiclesWeDoNotDetail: 'motorcycles, RVs and campers, boats, trailers, box trucks, semis and heavy equipment',
  vehiclesManagerDecides:
    'exotic, classic or collector cars, lifted or dually trucks, commercial or fleet vehicles, and anything with mold or biohazard contamination',
  notOfferedButQuotable: 'ceramic coating, paint correction and paint protection film',

  prep: [
    'Take out personal belongings and valuables, including the glove box, console and door pockets if you want them cleaned.',
    'Remove child car seats. We clean around them otherwise and cannot reinstall them.',
    'Empty the trunk or cargo area if you want it vacuumed.',
    'Let us know about pet hair, heavy stains, smoke odor or spills ahead of time, since some need an add-on.',
    'The vehicle needs to be drivable and you leave the key with us.',
    'Arrive five to ten minutes before your appointment time.',
  ],

  policies: [
    'Payment is due at pickup. We take all major cards, Apple Pay, Google Pay and cash. No deposit is needed to book.',
    'There is no cancellation fee. We ask for 24 hours of notice when possible.',
    'Up to 15 minutes late is fine. Later than that and we may need to move the appointment so the next customer is not delayed.',
    'You can wait in the lobby (free Wi-Fi) or drop the vehicle off and pick it up before closing.',
    'We do not offer mobile detailing or pickup and delivery. All work is done at the shop.',
  ],
} as const;
