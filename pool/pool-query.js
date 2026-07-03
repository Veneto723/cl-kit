// Called as a child process by usage-monitor.js to query the pool metrics DB.
// Exits 0 with JSON on stdout, non-zero on error.
// NODE_NO_WARNINGS suppresses the pg SSL deprecation noise so stdout is clean JSON.
process.env.NODE_NO_WARNINGS = '1';
process.removeAllListeners('warning');

const neonUrl = require('./pool-neon-url')();
if (!neonUrl) { process.stderr.write('no pool DB configured (cl-config poolDb.neonUrl)'); process.exit(1); }

const { Client } = require('pg');
const c = new Client(neonUrl);
c.on('error', () => {});
c.connect()
  .then(() => c.query(`
    SELECT p.email, p.label, p.status, p.reason_code,
           au.five_hour_utilization AS fh, au.five_hour_resets_at AS fh_reset,
           au.seven_day_utilization AS sd, au.seven_day_resets_at AS sd_reset,
           au.fetched_at
    FROM pool_accounts p
    LEFT JOIN account_usage au ON au.account_id = p.id
    WHERE p.type = 'claude_code'
    ORDER BY p.status, p.email
  `))
  .then(r => { process.stdout.write(JSON.stringify(r.rows)); c.end().catch(() => {}); })
  .catch(e => { process.stderr.write(e.message); process.exit(1); });
