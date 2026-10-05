import { auth, sheets, type sheets_v4 } from '@googleapis/sheets';
import { googleAuthOptions } from '../google/credentials.js';
import { phoneKey } from '../time.js';
import {
  CALL_LOG_COLUMNS,
  CALL_LOG_TAB,
  CONTACTS_TAB,
  CONTACT_COLUMNS,
  type CallLogRow,
  type Contact,
  type ContactsStore,
} from './types.js';

type Cell = string | number | boolean;
type Column = { key: string; header: string };

interface Table {
  /** Column index (0-based) for each of our keys, located by header text. */
  index: Record<string, number>;
  /** Data rows (row 2 onwards), as returned by the API. */
  rows: Cell[][];
  width: number;
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * Google Sheets backed contacts and call log.
 *
 * Columns are located by their header text, so the sheet owner can reorder
 * columns or add their own without breaking the agent, and updating a row
 * leaves any extra columns untouched.
 */
export class GoogleContacts implements ContactsStore {
  private api: sheets_v4.Sheets;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private spreadsheetId: string) {
    this.api = sheets({ version: 'v4', auth: new auth.GoogleAuth(googleAuthOptions()), timeout: 15_000 });
  }

  /** Read-modify-write on a sheet is not atomic, so run operations one at a time. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }

  async ensureSchema(): Promise<void> {
    await this.serial(async () => {
      const meta = await this.api.spreadsheets.get({
        spreadsheetId: this.spreadsheetId,
        fields: 'sheets.properties.title',
      });
      // Sheet names are unique regardless of case, so compare that way.
      const titles = new Set((meta.data.sheets ?? []).map((s) => norm(s.properties?.title)));
      const missing = [CONTACTS_TAB, CALL_LOG_TAB].filter((t) => !titles.has(norm(t)));
      if (missing.length) {
        await this.api.spreadsheets.batchUpdate({
          spreadsheetId: this.spreadsheetId,
          requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) },
        });
      }
      await this.loadTable(CONTACTS_TAB, CONTACT_COLUMNS);
      await this.loadTable(CALL_LOG_TAB, CALL_LOG_COLUMNS);
    });
  }

  /** Read a tab, adding any of our headers that are not there yet. */
  private async loadTable(tab: string, columns: Column[]): Promise<Table> {
    const res = await this.api.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `'${tab}'`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const values = (res.data.values ?? []) as Cell[][];
    const headers = (values[0] ?? []).map((h) => String(h ?? ''));
    const index: Record<string, number> = {};
    let changed = false;
    for (const col of columns) {
      let i = headers.findIndex((h) => norm(h) === norm(col.header));
      if (i < 0) {
        // Always add to the right: a blank header cell may still have someone's data under it.
        i = headers.length;
        headers[i] = col.header;
        changed = true;
      }
      index[col.key] = i;
    }
    if (changed) {
      await this.api.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `'${tab}'!A1:${columnLetter(headers.length - 1)}1`,
        valueInputOption: 'RAW',
        requestBody: { values: [headers] },
      });
    }
    return { index, rows: values.slice(1), width: headers.length };
  }

  private async writeRow(tab: string, table: Table, rowIndex: number, record: Record<string, Cell>): Promise<void> {
    // The Sheets API skips null cells, so on an update columns we do not own (including
    // any formulas the owner added) are left exactly as they are.
    const row: (Cell | null)[] = Array.from({ length: table.width }, () => (rowIndex >= 0 ? null : ''));
    for (const [key, i] of Object.entries(table.index)) row[i] = record[key] ?? '';

    if (rowIndex >= 0) {
      const sheetRow = rowIndex + 2; // +1 for the header row, +1 for 1-based rows
      await this.api.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `'${tab}'!A${sheetRow}:${columnLetter(table.width - 1)}${sheetRow}`,
        valueInputOption: 'RAW',
        requestBody: { values: [row] },
      });
    } else {
      await this.api.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: `'${tab}'!A1`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [row] },
      });
    }
  }

  private static toContact(table: Table, row: Cell[]): Contact {
    const get = (key: keyof Contact) => String(row[table.index[key]] ?? '');
    return {
      phone: get('phone'),
      name: get('name'),
      vehicle: get('vehicle'),
      firstContact: get('firstContact'),
      lastContact: get('lastContact'),
      totalCalls: Number(row[table.index.totalCalls] ?? 0) || 0,
      lastCallReason: get('lastCallReason'),
      lastCallSummary: get('lastCallSummary'),
      nextAppointment: get('nextAppointment'),
      needsFollowUp: get('needsFollowUp'),
      callHistory: get('callHistory'),
      callIds: get('callIds'),
    };
  }

  private static findContactRow(table: Table, phone: string): number {
    const key = phoneKey(phone);
    if (!key) return -1;
    return table.rows.findIndex((r) => phoneKey(String(r[table.index.phone] ?? '')) === key);
  }

  async getContact(phone: string): Promise<Contact | null> {
    return this.serial(async () => {
      const table = await this.loadTable(CONTACTS_TAB, CONTACT_COLUMNS);
      const i = GoogleContacts.findContactRow(table, phone);
      return i >= 0 ? GoogleContacts.toContact(table, table.rows[i]) : null;
    });
  }

  async saveContact(contact: Contact): Promise<void> {
    await this.serial(async () => {
      const table = await this.loadTable(CONTACTS_TAB, CONTACT_COLUMNS);
      const i = GoogleContacts.findContactRow(table, contact.phone);
      await this.writeRow(CONTACTS_TAB, table, i, contact as unknown as Record<string, Cell>);
    });
  }

  async saveCallLog(row: CallLogRow): Promise<void> {
    await this.serial(async () => {
      const table = await this.loadTable(CALL_LOG_TAB, CALL_LOG_COLUMNS);
      const i = table.rows.findIndex((r) => String(r[table.index.callId] ?? '') === row.callId);
      await this.writeRow(CALL_LOG_TAB, table, i, row as unknown as Record<string, Cell>);
    });
  }
}
