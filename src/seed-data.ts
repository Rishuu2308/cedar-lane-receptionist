/**
 * Demo data, generated relative to "now" so it is always in the future.
 * Used by `npm run seed` (writes it to Google) and by STORE=memory mode.
 *
 * It sets up the situations worth testing:
 *  - Thursday 3:30 PM is taken and 4:30 PM is free (the conversation in the brief)
 *  - a customer with an appointment to move or cancel (Dana Kim, Friday 10:00 AM)
 *  - a fully booked day (Saturday)
 *  - a non-customer event that still blocks time (Monday staff lunch)
 *  - a one-off closure (Wednesday, all-day event)
 *  - a customer due in today, for "I'm running late" (Jordan Lee), when today has room
 */
import type { DateTime } from 'luxon';
import type { NewEvent } from './calendar/types.js';
import type { Contact } from './contacts/types.js';
import { AGENT_PROP } from './scheduling.js';
import { SHOP, getService, type ServiceId } from './shop.js';
import { hoursFor, prettyPhone } from './time.js';

export const SEED_PROP = 'seed';

interface SeedCustomer {
  name: string;
  phone: string;
  vehicle: string;
}

const MARCUS: SeedCustomer = { name: 'Marcus Webb', phone: '+14155550111', vehicle: '2020 Toyota Camry' };
const PRIYA: SeedCustomer = { name: 'Priya Nair', phone: '+14155550123', vehicle: '2022 Tesla Model Y' };
const DANA: SeedCustomer = { name: 'Dana Kim', phone: '+14155550142', vehicle: '2019 Subaru Outback' };
const JORDAN: SeedCustomer = { name: 'Jordan Lee', phone: '+14155550177', vehicle: '2018 Ford F-150' };
const WALK_INS: SeedCustomer[] = [
  { name: 'Alex Romero', phone: '+14155550151', vehicle: '2021 Honda Civic' },
  { name: 'Sam Patel', phone: '+14155550152', vehicle: '2017 Jeep Wrangler' },
  { name: 'Lena Fischer', phone: '+14155550153', vehicle: '2023 Kia Telluride' },
  { name: 'Chris Okafor', phone: '+14155550154', vehicle: '2016 Mazda 3' },
];

function appointment(day: DateTime, time: string, serviceId: ServiceId, who: SeedCustomer): NewEvent {
  const service = getService(serviceId)!;
  const [h, m] = time.split(':').map(Number);
  const start = day.startOf('day').set({ hour: h, minute: m });
  const end = start.plus({ minutes: service.durationMinutes });
  return {
    start: start.toUTC().toISO()!,
    end: end.toUTC().toISO()!,
    summary: `${service.name} - ${who.name} (${prettyPhone(who.phone)})`,
    description: `Service: ${service.name}\nCustomer: ${who.name}\nPhone: ${prettyPhone(who.phone)}\nVehicle: ${who.vehicle}\n(Seeded test data)`,
    props: { [AGENT_PROP]: '1', [SEED_PROP]: '1', service: service.id, name: who.name, phone: who.phone, vehicle: who.vehicle },
  };
}

/**
 * The Thursday that "Thursday at 3:30" resolves to: today if that time can still be
 * booked, otherwise next week. Mirrors the rule in Tools.resolveStart.
 */
export function seedThursday(now: DateTime): DateTime {
  const delta = (4 - now.weekday + 7) % 7;
  const day = now.startOf('day').plus({ days: delta });
  const stillBookableToday = day.set({ hour: 15, minute: 30 }) >= now.plus({ minutes: SHOP.minLeadMinutes });
  return delta === 0 && !stillBookableToday ? day.plus({ days: 7 }) : day;
}

export function seedEvents(now: DateTime): NewEvent[] {
  const thu = seedThursday(now);
  const fri = thu.plus({ days: 1 });
  const sat = thu.plus({ days: 2 });
  const mon = thu.plus({ days: 4 });
  const wed = thu.plus({ days: 6 });

  const events: NewEvent[] = [
    // Thursday: 3:30 PM is full, 4:30 PM is open.
    appointment(thu, '13:00', 'full_detail', PRIYA),
    appointment(thu, '15:30', 'interior_detail_wash', MARCUS),
    // Friday: Dana's appointment, for reschedule / cancel.
    appointment(fri, '10:00', 'exterior_detail', DANA),
    // Saturday (9 to 4): no room left.
    appointment(sat, '09:00', 'full_detail', WALK_INS[0]),
    appointment(sat, '11:30', 'full_detail', WALK_INS[1]),
    appointment(sat, '14:00', 'interior_detail_wash', WALK_INS[2]),
    appointment(sat, '15:00', 'exterior_detail', WALK_INS[3]),
    // Monday: a staff event typed in by hand (no customer, no properties) still blocks the hour.
    {
      start: mon.set({ hour: 12 }).toUTC().toISO()!,
      end: mon.set({ hour: 13 }).toUTC().toISO()!,
      summary: 'Staff lunch and training',
      description: '(Seeded test data)',
      props: { [SEED_PROP]: '1' },
    },
    // Wednesday: closed all day.
    {
      start: wed.toUTC().toISO()!,
      end: wed.plus({ days: 1 }).toUTC().toISO()!,
      allDay: true,
      summary: 'Shop closed - equipment maintenance',
      description: '(Seeded test data)',
      props: { [SEED_PROP]: '1' },
    },
  ];

  // Today: someone due in a couple of hours, so "I'm running late" can be tried.
  const hours = hoursFor(now);
  if (hours) {
    const minute = now.minute < 30 ? 30 : 60;
    const start = now.startOf('hour').plus({ minutes: minute + 90 });
    if (start >= hours.open && start.plus({ minutes: 60 }) <= hours.close && !start.hasSame(thu, 'day')) {
      events.push(appointment(now, start.toFormat('HH:mm'), 'interior_detail_wash', JORDAN));
    }
  }
  return events;
}

export function seedContacts(now: DateTime): Contact[] {
  const stamp = now.minus({ days: 3 }).toFormat('yyyy-LL-dd h:mm a');
  const row = (who: SeedCustomer, summary: string): Contact => ({
    phone: who.phone,
    name: who.name,
    vehicle: who.vehicle,
    firstContact: stamp,
    lastContact: stamp,
    totalCalls: 1,
    lastCallReason: 'booking',
    lastCallSummary: summary,
    nextAppointment: '',
    needsFollowUp: '',
    callHistory: `${stamp} [booking] ${summary}`,
    callIds: 'seed',
  });
  return [
    row(MARCUS, 'Booked an Interior Detail & Wash.'),
    row(PRIYA, 'Booked a Full Detail.'),
    row(DANA, 'Booked an Exterior Detail.'),
    row(JORDAN, 'Booked an Interior Detail & Wash.'),
  ];
}

/** Human-readable description of what was seeded, for the seed script's output. */
export function describeSeed(now: DateTime): string[] {
  const thu = seedThursday(now);
  const f = (d: DateTime) => d.toFormat('ccc LLL d');
  return [
    `${f(thu)}: Full Detail 1:00-3:30 PM and Interior Detail & Wash 3:30-4:30 PM are booked. 4:30 PM is open.`,
    `${f(thu.plus({ days: 1 }))}: Dana Kim, ${prettyPhone(DANA.phone)}, Exterior Detail at 10:00 AM (try rescheduling or cancelling it).`,
    `${f(thu.plus({ days: 2 }))}: fully booked.`,
    `${f(thu.plus({ days: 4 }))}: staff lunch 12:00-1:00 PM blocks that hour.`,
    `${f(thu.plus({ days: 6 }))}: shop closed all day.`,
    `Today: if the shop has room, Jordan Lee, ${prettyPhone(JORDAN.phone)}, is due in about two hours (try "I'm running late").`,
    `Shop timezone: ${SHOP.timezone}.`,
  ];
}
