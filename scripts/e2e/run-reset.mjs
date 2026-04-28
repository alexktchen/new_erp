import { Client } from 'pg';
import { readFileSync } from 'fs';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const files = [
  'scripts/e2e/00-truncate.sql',
  'scripts/e2e/01-master.sql',
  'scripts/e2e/02-base-fixtures.sql',
  'scripts/e2e/fixtures/with-campaign.sql',
];

function prepSql(raw) {
  return raw
    .split('\n')
    .filter(l => !l.trimStart().startsWith('\\'))
    .join('\n')
    .replace(/:'tenant_id'/g, `'${TENANT_ID}'`);
}

const c = new Client({
  host: 'aws-1-ap-southeast-1.pooler.supabase.com',
  port: 5432,
  user: 'postgres.anfyoeviuhmzzrhilwtm',
  password: '@Ss0929283575',
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
});

await c.connect();
for (const f of files) {
  const sql = prepSql(readFileSync(f, 'utf8'));
  process.stdout.write(`→ ${f} ... `);
  try {
    await c.query(sql);
    console.log('done');
  } catch (e) {
    console.log('ERROR: ' + e.message.split('\n')[0]);
  }
}
await c.end();
