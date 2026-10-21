import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const collectorEntries=sqliteTable('collector_entries',{
  key:text('key').primaryKey(),
  payload:text('payload'),
  nextPollAt:integer('next_poll_at').notNull().default(0),
  leaseUntil:integer('lease_until').notNull().default(0),
  leaseToken:text('lease_token').notNull().default(''),
  lastStartedAt:integer('last_started_at').notNull().default(0),
  fetchCount:integer('fetch_count').notNull().default(0),
  failureCount:integer('failure_count').notNull().default(0),
  lastError:text('last_error'),
});
