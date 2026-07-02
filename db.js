const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('\n[오류] 환경변수 DATABASE_URL 이 설정되지 않았습니다.');
  console.error('       Supabase 연결 문자열을 DATABASE_URL 로 지정한 뒤 다시 실행해 주세요.\n');
  process.exit(1);
}

const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

const CAPACITY = 100;
const WAITLIST_THRESHOLD = 80; // 80% -> '마감 대기 중'

// 신청 가능한 고정 일정 (날짜 × 오전/오후)
const SLOT_DEFS = [
  { id: '0718-am', date: '2026-07-18', day: '토', period: '오전', label: '7월 18일(토) 오전' },
  { id: '0718-pm', date: '2026-07-18', day: '토', period: '오후', label: '7월 18일(토) 오후' },
  { id: '0719-am', date: '2026-07-19', day: '일', period: '오전', label: '7월 19일(일) 오전' },
  { id: '0719-pm', date: '2026-07-19', day: '일', period: '오후', label: '7월 19일(일) 오후' },
  { id: '0721-am', date: '2026-07-21', day: '화', period: '오전', label: '7월 21일(화) 오전' },
  { id: '0721-pm', date: '2026-07-21', day: '화', period: '오후', label: '7월 21일(화) 오후' },
  { id: '0722-am', date: '2026-07-22', day: '수', period: '오전', label: '7월 22일(수) 오전' },
  { id: '0722-pm', date: '2026-07-22', day: '수', period: '오후', label: '7월 22일(수) 오후' },
];

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS slots (
      id     text PRIMARY KEY,
      date   text NOT NULL,
      day    text NOT NULL,
      period text NOT NULL,
      label  text NOT NULL,
      sort   int  NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registrations (
      id         serial PRIMARY KEY,
      name       text NOT NULL,
      email      text NOT NULL,
      phone      text NOT NULL,
      slot_id    text NOT NULL REFERENCES slots(id),
      edit_count int  NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_reg_email ON registrations (lower(email));
    CREATE INDEX IF NOT EXISTS idx_reg_slot ON registrations (slot_id);
  `);
  for (let i = 0; i < SLOT_DEFS.length; i++) {
    const s = SLOT_DEFS[i];
    await pool.query(
      `INSERT INTO slots (id, date, day, period, label, sort)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
      [s.id, s.date, s.day, s.period, s.label, i]
    );
  }
}

// --- 상태 계산 ---
function statusOf(count) {
  if (count >= CAPACITY) return 'full'; // 마감
  if (count >= WAITLIST_THRESHOLD) return 'waitlist'; // 마감 대기 중
  return 'open';
}

async function slotsWithCounts() {
  const { rows } = await pool.query(
    `SELECT s.id, s.date, s.day, s.period, s.label,
            (SELECT COUNT(*)::int FROM registrations r WHERE r.slot_id = s.id) AS count
     FROM slots s ORDER BY s.sort`
  );
  return rows.map((r) => ({
    ...r,
    capacity: CAPACITY,
    remaining: Math.max(CAPACITY - r.count, 0),
    status: statusOf(r.count),
  }));
}

// --- 신청 (원자적: 슬롯별 advisory lock + 이메일 UNIQUE) ---
// code: 'DUPLICATE' | 'FULL' | 'BAD_SLOT'
async function register({ name, email, phone, slotId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const slot = await client.query('SELECT 1 FROM slots WHERE id = $1', [slotId]);
    if (!slot.rowCount) { await client.query('ROLLBACK'); return { ok: false, code: 'BAD_SLOT' }; }

    // 동일 슬롯 동시 신청을 직렬화해 정원 초과 방지
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [slotId]);

    const dup = await client.query('SELECT 1 FROM registrations WHERE lower(email) = lower($1)', [email]);
    if (dup.rowCount) { await client.query('ROLLBACK'); return { ok: false, code: 'DUPLICATE' }; }

    const cnt = await client.query('SELECT COUNT(*)::int AS c FROM registrations WHERE slot_id = $1', [slotId]);
    if (cnt.rows[0].c >= CAPACITY) { await client.query('ROLLBACK'); return { ok: false, code: 'FULL' }; }

    const ins = await client.query(
      `INSERT INTO registrations (name, email, phone, slot_id) VALUES ($1,$2,$3,$4) RETURNING id`,
      [name, email, phone, slotId]
    );
    await client.query('COMMIT');
    return { ok: true, registration: await getById(ins.rows[0].id) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') return { ok: false, code: 'DUPLICATE' }; // 이메일 UNIQUE 위반
    throw e;
  } finally {
    client.release();
  }
}

// --- 수정 (1회 한정, 원자적) ---
// code: 'NOT_FOUND' | 'EDIT_LIMIT' | 'FULL' | 'BAD_SLOT' | 'SAME_SLOT'
async function updateSlot({ email, slotId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const slot = await client.query('SELECT 1 FROM slots WHERE id = $1', [slotId]);
    if (!slot.rowCount) { await client.query('ROLLBACK'); return { ok: false, code: 'BAD_SLOT' }; }

    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [slotId]);

    const reg = await client.query('SELECT * FROM registrations WHERE lower(email) = lower($1)', [email]);
    if (!reg.rowCount) { await client.query('ROLLBACK'); return { ok: false, code: 'NOT_FOUND' }; }
    const r = reg.rows[0];
    if (r.edit_count >= 1) { await client.query('ROLLBACK'); return { ok: false, code: 'EDIT_LIMIT' }; }
    if (r.slot_id === slotId) { await client.query('ROLLBACK'); return { ok: false, code: 'SAME_SLOT' }; }

    const cnt = await client.query('SELECT COUNT(*)::int AS c FROM registrations WHERE slot_id = $1', [slotId]);
    if (cnt.rows[0].c >= CAPACITY) { await client.query('ROLLBACK'); return { ok: false, code: 'FULL' }; }

    await client.query(
      `UPDATE registrations SET slot_id = $1, edit_count = edit_count + 1, updated_at = now() WHERE id = $2`,
      [slotId, r.id]
    );
    // 기존 slot의 자리는 집계 방식이므로 자동 반납됨
    await client.query('COMMIT');
    return { ok: true, registration: await getById(r.id) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function getById(id) {
  const { rows } = await pool.query(
    `SELECT r.*, s.label AS slot_label FROM registrations r
     JOIN slots s ON s.id = r.slot_id WHERE r.id = $1`,
    [id]
  );
  return rows[0];
}

async function getByEmail(email) {
  const { rows } = await pool.query(
    `SELECT r.*, s.label AS slot_label FROM registrations r
     JOIN slots s ON s.id = r.slot_id WHERE lower(r.email) = lower($1)`,
    [email]
  );
  return rows[0];
}

async function allRegistrations(search) {
  let sql = `SELECT r.id, r.name, r.email, r.phone, r.slot_id, r.edit_count,
                    r.created_at, r.updated_at, s.label AS slot_label, s.sort
             FROM registrations r JOIN slots s ON s.id = r.slot_id`;
  const params = [];
  if (search) {
    sql += ` WHERE r.name ILIKE $1 OR r.email ILIKE $1 OR r.phone ILIKE $1`;
    params.push('%' + search + '%');
  }
  sql += ` ORDER BY r.created_at DESC`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

module.exports = {
  CAPACITY,
  WAITLIST_THRESHOLD,
  init,
  slotsWithCounts,
  register,
  updateSlot,
  getByEmail,
  allRegistrations,
};
