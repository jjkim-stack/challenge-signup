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

const DEFAULT_CAPACITY = 100;
const WAITLIST_RATIO = 0.8; // 정원의 80% 도달 시 '마감 대기 중'
const DEFAULT_COHORT = '14';

// 기수별 신청 일정. cohort 로 기수를 구분한다. capacity 미지정 시 DEFAULT_CAPACITY(100).
const SLOT_DEFS = [
  // --- 14기 ---
  { id: '0718-am', cohort: '14', date: '2026-07-18', day: '토', period: '오전', label: '7월 18일(토) 오전', place: '스페이스쉐어 삼성역센터 1층 하모니홀' },
  { id: '0718-pm', cohort: '14', date: '2026-07-18', day: '토', period: '오후', label: '7월 18일(토) 오후', place: '스페이스쉐어 삼성역센터 1층 하모니홀' },
  { id: '0719-am', cohort: '14', date: '2026-07-19', day: '일', period: '오전', label: '7월 19일(일) 오전', place: '스페이스쉐어 강남센터 3층 주피터홀' },
  { id: '0719-pm', cohort: '14', date: '2026-07-19', day: '일', period: '오후', label: '7월 19일(일) 오후', place: '스페이스쉐어 강남센터 3층 주피터홀' },
  { id: '0721-am', cohort: '14', date: '2026-07-21', day: '화', period: '오전', label: '7월 21일(화) 오전', place: '스페이스쉐어 강남센터 3층 주피터홀' },
  { id: '0721-pm', cohort: '14', date: '2026-07-21', day: '화', period: '오후', label: '7월 21일(화) 오후', place: '스페이스쉐어 강남센터 3층 주피터홀' },
  { id: '0722-am', cohort: '14', date: '2026-07-22', day: '수', period: '오전', label: '7월 22일(수) 오전', place: '스페이스쉐어 강남센터 4층 비너스홀', capacity: 80 },
  { id: '0722-pm', cohort: '14', date: '2026-07-22', day: '수', period: '오후', label: '7월 22일(수) 오후', place: '스페이스쉐어 강남센터 4층 비너스홀', capacity: 80 },
  { id: 'absent', cohort: '14', date: '', day: '', period: '', label: '미참석', place: null, capacity: 1000000 },

  // --- 15기 ---
  { id: '15-0919-am', cohort: '15', date: '2026-09-19', day: '토', period: '오전', label: '9월 19일(토) 오전', place: '강남역 근처', capacity: 100 },
  { id: '15-0919-pm', cohort: '15', date: '2026-09-19', day: '토', period: '오후', label: '9월 19일(토) 오후', place: '강남역 근처', capacity: 100 },
  { id: '15-absent', cohort: '15', date: '', day: '', period: '', label: '미참석', place: null, capacity: 1000000 },
];

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS slots (
      id     text PRIMARY KEY,
      date   text NOT NULL,
      day    text NOT NULL,
      period text NOT NULL,
      label    text NOT NULL,
      place    text,
      capacity int NOT NULL DEFAULT 100,
      sort     int NOT NULL
    );
    ALTER TABLE slots ADD COLUMN IF NOT EXISTS place text;
    ALTER TABLE slots ADD COLUMN IF NOT EXISTS capacity int NOT NULL DEFAULT 100;
    ALTER TABLE slots ADD COLUMN IF NOT EXISTS cohort text NOT NULL DEFAULT '14';
    CREATE TABLE IF NOT EXISTS registrations (
      id         serial PRIMARY KEY,
      name       text NOT NULL,
      email      text,
      phone      text NOT NULL,
      slot_id    text NOT NULL REFERENCES slots(id),
      edit_count int  NOT NULL DEFAULT 0,
      attended   boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE registrations ADD COLUMN IF NOT EXISTS attended boolean NOT NULL DEFAULT false;
    ALTER TABLE registrations ADD COLUMN IF NOT EXISTS attended_at timestamptz;
    ALTER TABLE registrations ADD COLUMN IF NOT EXISTS cohort text NOT NULL DEFAULT '14';
    ALTER TABLE registrations ALTER COLUMN email DROP NOT NULL;
    DROP INDEX IF EXISTS ux_reg_email;
    CREATE UNIQUE INDEX IF NOT EXISTS ux_reg_email_cohort ON registrations (cohort, lower(email));
    CREATE INDEX IF NOT EXISTS idx_reg_slot ON registrations (slot_id);
    CREATE INDEX IF NOT EXISTS idx_reg_cohort ON registrations (cohort);
  `);
  for (let i = 0; i < SLOT_DEFS.length; i++) {
    const s = SLOT_DEFS[i];
    await pool.query(
      `INSERT INTO slots (id, cohort, date, day, period, label, place, capacity, sort)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         cohort = EXCLUDED.cohort, place = EXCLUDED.place,
         label = EXCLUDED.label, capacity = EXCLUDED.capacity`,
      [s.id, s.cohort, s.date, s.day, s.period, s.label, s.place, s.capacity || DEFAULT_CAPACITY, i]
    );
  }
}

// --- 상태 계산 ---
function statusOf(count, capacity) {
  if (count >= capacity) return 'full'; // 마감
  if (count >= Math.ceil(capacity * WAITLIST_RATIO)) return 'waitlist'; // 마감 대기 중
  return 'open';
}

async function slotsWithCounts(cohort = DEFAULT_COHORT) {
  const { rows } = await pool.query(
    `SELECT s.id, s.date, s.day, s.period, s.label, s.place, s.capacity,
            (SELECT COUNT(*)::int FROM registrations r WHERE r.slot_id = s.id) AS count
     FROM slots s WHERE s.cohort = $1 ORDER BY s.sort`,
    [cohort]
  );
  return rows.map((r) => ({
    ...r,
    capacity: r.capacity,
    remaining: Math.max(r.capacity - r.count, 0),
    status: statusOf(r.count, r.capacity),
  }));
}

// --- 신청 (원자적: 슬롯별 advisory lock + (기수,이메일) UNIQUE) ---
// code: 'DUPLICATE' | 'FULL' | 'BAD_SLOT'
async function register({ name, email, phone, slotId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const slot = await client.query('SELECT capacity, cohort FROM slots WHERE id = $1', [slotId]);
    if (!slot.rowCount) { await client.query('ROLLBACK'); return { ok: false, code: 'BAD_SLOT' }; }
    const { capacity, cohort } = slot.rows[0];

    // 동일 슬롯 동시 신청을 직렬화해 정원 초과 방지
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [slotId]);

    const dup = await client.query(
      'SELECT 1 FROM registrations WHERE cohort = $1 AND lower(email) = lower($2)', [cohort, email]);
    if (dup.rowCount) { await client.query('ROLLBACK'); return { ok: false, code: 'DUPLICATE' }; }

    const cnt = await client.query('SELECT COUNT(*)::int AS c FROM registrations WHERE slot_id = $1', [slotId]);
    if (cnt.rows[0].c >= capacity) { await client.query('ROLLBACK'); return { ok: false, code: 'FULL' }; }

    const ins = await client.query(
      `INSERT INTO registrations (name, email, phone, slot_id, cohort) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [name, email, phone, slotId, cohort]
    );
    await client.query('COMMIT');
    return { ok: true, registration: await getById(ins.rows[0].id) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') return { ok: false, code: 'DUPLICATE' }; // (기수,이메일) UNIQUE 위반
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

    const slot = await client.query('SELECT capacity, cohort FROM slots WHERE id = $1', [slotId]);
    if (!slot.rowCount) { await client.query('ROLLBACK'); return { ok: false, code: 'BAD_SLOT' }; }
    const { capacity, cohort } = slot.rows[0];

    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [slotId]);

    const reg = await client.query(
      'SELECT * FROM registrations WHERE cohort = $1 AND lower(email) = lower($2)', [cohort, email]);
    if (!reg.rowCount) { await client.query('ROLLBACK'); return { ok: false, code: 'NOT_FOUND' }; }
    const r = reg.rows[0];
    if (r.edit_count >= 1) { await client.query('ROLLBACK'); return { ok: false, code: 'EDIT_LIMIT' }; }
    if (r.slot_id === slotId) { await client.query('ROLLBACK'); return { ok: false, code: 'SAME_SLOT' }; }

    const cnt = await client.query('SELECT COUNT(*)::int AS c FROM registrations WHERE slot_id = $1', [slotId]);
    if (cnt.rows[0].c >= capacity) { await client.query('ROLLBACK'); return { ok: false, code: 'FULL' }; }

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

// --- 관리자 수동 추가 (정원 초과 허용, 이메일은 선택) ---
// code: 'BAD_SLOT' | 'DUPLICATE'
async function adminAdd({ name, email, phone, slotId }) {
  const mail = email && email.trim() ? email.trim() : null; // 이메일 미입력 시 NULL 저장
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const slot = await client.query('SELECT cohort FROM slots WHERE id = $1', [slotId]);
    if (!slot.rowCount) { await client.query('ROLLBACK'); return { ok: false, code: 'BAD_SLOT' }; }
    const cohort = slot.rows[0].cohort;

    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [slotId]);

    // 이메일이 있을 때만 중복 검사 (미입력은 여러 건 허용)
    if (mail) {
      const dup = await client.query(
        'SELECT 1 FROM registrations WHERE cohort = $1 AND lower(email) = lower($2)', [cohort, mail]);
      if (dup.rowCount) { await client.query('ROLLBACK'); return { ok: false, code: 'DUPLICATE' }; }
    }

    const ins = await client.query(
      `INSERT INTO registrations (name, email, phone, slot_id, cohort) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [name, mail, phone, slotId, cohort]
    );
    await client.query('COMMIT');
    return { ok: true, registration: await getById(ins.rows[0].id) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') return { ok: false, code: 'DUPLICATE' };
    throw e;
  } finally {
    client.release();
  }
}

// --- 관리자 수정 (이름/이메일/휴대폰/일정 자유 수정, 같은 기수 내 중복 이메일만 차단) ---
// code: 'BAD_SLOT' | 'DUPLICATE' | 'NOT_FOUND'
async function adminUpdate({ id, name, email, phone, slotId }) {
  const mail = email && email.trim() ? email.trim() : null; // 이메일 미입력 시 NULL
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const slot = await client.query('SELECT cohort FROM slots WHERE id = $1', [slotId]);
    if (!slot.rowCount) { await client.query('ROLLBACK'); return { ok: false, code: 'BAD_SLOT' }; }
    const cohort = slot.rows[0].cohort;

    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [slotId]);

    if (mail) {
      const dup = await client.query(
        'SELECT 1 FROM registrations WHERE cohort = $1 AND lower(email) = lower($2) AND id <> $3',
        [cohort, mail, id]);
      if (dup.rowCount) { await client.query('ROLLBACK'); return { ok: false, code: 'DUPLICATE' }; }
    }

    const upd = await client.query(
      `UPDATE registrations SET name = $1, email = $2, phone = $3, slot_id = $4, cohort = $5, updated_at = now()
       WHERE id = $6`,
      [name, mail, phone, slotId, cohort, id]
    );
    if (!upd.rowCount) { await client.query('ROLLBACK'); return { ok: false, code: 'NOT_FOUND' }; }
    await client.query('COMMIT');
    return { ok: true, registration: await getById(id) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') return { ok: false, code: 'DUPLICATE' };
    throw e;
  } finally {
    client.release();
  }
}

async function getById(id) {
  const { rows } = await pool.query(
    `SELECT r.*, s.label AS slot_label, s.place AS slot_place FROM registrations r
     JOIN slots s ON s.id = r.slot_id WHERE r.id = $1`,
    [id]
  );
  return rows[0];
}

async function getByEmail(email, cohort = DEFAULT_COHORT) {
  const { rows } = await pool.query(
    `SELECT r.*, s.label AS slot_label, s.place AS slot_place FROM registrations r
     JOIN slots s ON s.id = r.slot_id WHERE r.cohort = $2 AND lower(r.email) = lower($1)`,
    [email, cohort]
  );
  return rows[0];
}

// 휴대폰 번호로 조회 (숫자만 비교해 하이픈/공백 차이 무시). 여러 건이면 최신 1건.
async function getByPhone(phone, cohort = DEFAULT_COHORT) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return undefined;
  const { rows } = await pool.query(
    `SELECT r.*, s.label AS slot_label, s.place AS slot_place FROM registrations r
     JOIN slots s ON s.id = r.slot_id
     WHERE r.cohort = $2 AND regexp_replace(r.phone, '\\D', '', 'g') = $1
     ORDER BY r.created_at DESC LIMIT 1`,
    [digits, cohort]
  );
  return rows[0];
}

async function deleteById(id) {
  const { rowCount } = await pool.query('DELETE FROM registrations WHERE id = $1', [id]);
  return { ok: rowCount > 0 };
}

async function setAttendance({ id, attended }) {
  const { rowCount } = await pool.query(
    `UPDATE registrations SET attended = $1,
            attended_at = CASE WHEN $1 THEN now() ELSE NULL END
     WHERE id = $2`,
    [!!attended, id]
  );
  return { ok: rowCount > 0 };
}

// 휴대폰 뒷 4자리로 신청 내역 조회 (여러 명일 수 있음)
async function findByPhoneTail(tail, cohort = DEFAULT_COHORT) {
  const digits = String(tail || '').replace(/\D/g, '');
  if (digits.length !== 4) return [];
  const { rows } = await pool.query(
    `SELECT r.id, r.name, r.phone, r.attended, r.attended_at,
            r.slot_id, s.label AS slot_label, s.place AS slot_place
     FROM registrations r JOIN slots s ON s.id = r.slot_id
     WHERE r.cohort = $2 AND right(regexp_replace(r.phone, '\\D', '', 'g'), 4) = $1
     ORDER BY s.sort, r.name`,
    [digits, cohort]
  );
  return rows;
}

// 현장 출석 처리 (중복 출석 방지)
// code: 'NOT_FOUND' | 'ALREADY'
async function checkIn(id) {
  const cur = await pool.query(
    `SELECT r.*, s.label AS slot_label, s.place AS slot_place
     FROM registrations r JOIN slots s ON s.id = r.slot_id WHERE r.id = $1`,
    [id]
  );
  if (!cur.rowCount) return { ok: false, code: 'NOT_FOUND' };
  if (cur.rows[0].attended) return { ok: false, code: 'ALREADY', registration: cur.rows[0] };

  const upd = await pool.query(
    `UPDATE registrations SET attended = true, attended_at = now()
     WHERE id = $1 AND attended = false RETURNING attended_at`,
    [id]
  );
  if (!upd.rowCount) { // 동시 요청으로 이미 처리된 경우
    return { ok: false, code: 'ALREADY', registration: await getById(id) };
  }
  const reg = cur.rows[0];
  reg.attended = true;
  reg.attended_at = upd.rows[0].attended_at;
  return { ok: true, registration: reg };
}

async function allRegistrations(search, slotId, cohort = DEFAULT_COHORT) {
  let sql = `SELECT r.id, r.name, r.email, r.phone, r.slot_id, r.edit_count, r.attended, r.attended_at,
                    r.created_at, r.updated_at, s.label AS slot_label, s.sort
             FROM registrations r JOIN slots s ON s.id = r.slot_id`;
  const params = [cohort];
  const conds = ['r.cohort = $1'];
  if (search) {
    params.push('%' + search + '%');
    conds.push(`(r.name ILIKE $${params.length} OR r.email ILIKE $${params.length} OR r.phone ILIKE $${params.length})`);
  }
  if (slotId) {
    params.push(slotId);
    conds.push(`r.slot_id = $${params.length}`);
  }
  sql += ` WHERE ` + conds.join(' AND ');
  sql += ` ORDER BY r.created_at DESC`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

module.exports = {
  DEFAULT_CAPACITY,
  WAITLIST_RATIO,
  DEFAULT_COHORT,
  init,
  slotsWithCounts,
  register,
  updateSlot,
  getByEmail,
  getByPhone,
  allRegistrations,
  setAttendance,
  adminAdd,
  adminUpdate,
  deleteById,
  findByPhoneTail,
  checkIn,
};
