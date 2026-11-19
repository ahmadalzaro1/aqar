import postgres from 'postgres';

const url = process.env['DATABASE_URL'] ?? 'postgres://aqar:***@127.0.0.1:5433/aqar';
export const sql = postgres(url, { max: 5, idle_timeout: 20 });
