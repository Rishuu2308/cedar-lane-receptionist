import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Tests never touch Google, OpenAI or Vapi, whatever is in a local .env file.
    env: {
      STORE: 'memory',
      SHOP_TIMEZONE: 'America/Los_Angeles',
      SHOP_BAYS: '1',
      DEFAULT_COUNTRY_CODE: '1',
      GEMINI_API_KEY: '',
      PUBLIC_URL: 'https://receptionist.example.test',
      VAPI_WEBHOOK_SECRET: 'test-secret',
      HUMAN_TRANSFER_NUMBER: '',
      VAPI_TRANSCRIBER_MODEL: 'nova-3',
    },
  },
});
