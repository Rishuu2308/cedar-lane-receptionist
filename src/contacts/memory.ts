import { phoneKey } from '../time.js';
import type { CallLogRow, Contact, ContactsStore } from './types.js';

/** In-process contacts and call log used by tests, evals and STORE=memory demo mode. */
export class MemoryContacts implements ContactsStore {
  contacts: Contact[] = [];
  callLog: CallLogRow[] = [];

  constructor(initial: Contact[] = []) {
    this.contacts = initial.map((c) => ({ ...c }));
  }

  async ensureSchema(): Promise<void> {}

  async getContact(phone: string): Promise<Contact | null> {
    const c = this.contacts.find((x) => phoneKey(x.phone) === phoneKey(phone));
    return c ? { ...c } : null;
  }

  async saveContact(contact: Contact): Promise<void> {
    const i = this.contacts.findIndex((x) => phoneKey(x.phone) === phoneKey(contact.phone));
    if (i >= 0) this.contacts[i] = { ...contact };
    else this.contacts.push({ ...contact });
  }

  async saveCallLog(row: CallLogRow): Promise<void> {
    const i = this.callLog.findIndex((x) => x.callId === row.callId);
    if (i >= 0) this.callLog[i] = { ...row };
    else this.callLog.push({ ...row });
  }
}
