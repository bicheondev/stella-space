import {createClient} from '@libsql/client/web';

// The existing production schema is managed by the app, never by a public read.
export function createDatabase(env, {fetcher = fetch} = {}) {
  if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) throw Error('공유 데이터베이스 연결이 필요합니다.');
  const client = createClient({url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN, fetch: fetcher});
  return {
    prepare(sql) {
      return {bind(...args) {
        const execute = () => client.execute({sql, args});
        return {
          async first() { return (await execute()).rows[0] || null; },
          async all() { return {results: (await execute()).rows}; },
        };
      }};
    },
    close() { client.close(); },
  };
}
