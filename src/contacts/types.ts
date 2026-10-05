/** One row per caller in the "Contacts" tab, keyed by phone number. */
export interface Contact {
  phone: string; // E.164
  name: string;
  vehicle: string;
  firstContact: string;
  lastContact: string;
  totalCalls: number;
  lastCallReason: string;
  lastCallSummary: string;
  nextAppointment: string;
  /** Empty, or what a human needs to do for this caller. Staff clear it when done. */
  needsFollowUp: string;
  /** Newest first, one line per call. */
  callHistory: string;
  /** Call IDs for the lines in callHistory, same order, comma separated. */
  callIds: string;
}

/** One row per call in the "Call Log" tab, keyed by call id. */
export interface CallLogRow {
  timestamp: string;
  callId: string;
  channel: string;
  phone: string;
  name: string;
  reasons: string;
  summary: string;
  actions: string;
  followUpNeeded: string;
  followUpDetail: string;
  status: string;
}

export const CONTACT_COLUMNS: { key: keyof Contact; header: string }[] = [
  { key: 'phone', header: 'Phone' },
  { key: 'name', header: 'Name' },
  { key: 'vehicle', header: 'Vehicle' },
  { key: 'firstContact', header: 'First Contact' },
  { key: 'lastContact', header: 'Last Contact' },
  { key: 'totalCalls', header: 'Total Calls' },
  { key: 'lastCallReason', header: 'Last Call Reason' },
  { key: 'lastCallSummary', header: 'Last Call Summary' },
  { key: 'nextAppointment', header: 'Next Appointment' },
  { key: 'needsFollowUp', header: 'Needs Follow-up' },
  { key: 'callHistory', header: 'Call History (newest first)' },
  { key: 'callIds', header: 'Call IDs (newest first)' },
];

export const CALL_LOG_COLUMNS: { key: keyof CallLogRow; header: string }[] = [
  { key: 'timestamp', header: 'Timestamp' },
  { key: 'callId', header: 'Call ID' },
  { key: 'channel', header: 'Channel' },
  { key: 'phone', header: 'Phone' },
  { key: 'name', header: 'Name' },
  { key: 'reasons', header: 'Reasons' },
  { key: 'summary', header: 'Summary' },
  { key: 'actions', header: 'Actions Taken' },
  { key: 'followUpNeeded', header: 'Follow-up Needed' },
  { key: 'followUpDetail', header: 'Follow-up Detail' },
  { key: 'status', header: 'Status' },
];

export const CONTACTS_TAB = 'Contacts';
export const CALL_LOG_TAB = 'Call Log';

export interface ContactsStore {
  /** Create tabs and header rows if they are missing. */
  ensureSchema(): Promise<void>;
  getContact(phone: string): Promise<Contact | null>;
  /** Insert or replace the row for contact.phone. */
  saveContact(contact: Contact): Promise<void>;
  /** Insert or replace the row for row.callId. */
  saveCallLog(row: CallLogRow): Promise<void>;
}
