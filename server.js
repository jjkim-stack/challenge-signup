require('dotenv').config();
const path = require('path');
const express = require('express');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- 입력 검증 ---
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validApplicant({ name, email, phone }) {
  if (!name || !name.trim()) return '이름을 입력해 주세요.';
  if (!email || !EMAIL_RE.test(email.trim())) return '올바른 이메일을 입력해 주세요.';
  if (!phone || !phone.trim()) return '휴대폰 번호를 입력해 주세요.';
  return null;
}

const CODE_MSG = {
  DUPLICATE: '이미 신청 내역이 있는 이메일입니다. 일정 변경은 수정 페이지를 이용해 주세요.',
  FULL: '선택하신 일정이 마감되었습니다. 다른 일정을 선택해 주세요.',
  BAD_SLOT: '선택한 일정이 올바르지 않습니다.',
  NOT_FOUND: '해당 정보의 신청 내역을 찾을 수 없습니다.',
  EDIT_LIMIT: '일정 수정은 1회만 가능합니다. 이미 수정하셨습니다.',
  SAME_SLOT: '현재 신청한 일정과 동일합니다. 다른 일정을 선택해 주세요.',
};

// --- 공개 API ---
app.get('/api/slots', async (req, res, next) => {
  try {
    res.json({ slots: await db.slotsWithCounts() });
  } catch (e) { next(e); }
});

app.post('/api/register', async (req, res, next) => {
  try {
    const { name, email, phone, slotId } = req.body || {};
    const err = validApplicant({ name, email, phone });
    if (err) return res.status(400).json({ error: err });
    if (!slotId) return res.status(400).json({ error: '참석 일정을 선택해 주세요.' });

    const result = await db.register({
      name: name.trim(),
      email: email.trim(),
      phone: phone.trim(),
      slotId,
    });
    if (!result.ok) {
      // 중복 이메일이면 기존 신청 정보를 함께 내려 수정/조회 화면으로 전환할 수 있게 함
      const body = { error: CODE_MSG[result.code], code: result.code };
      if (result.code === 'DUPLICATE') {
        const existing = await db.getByEmail(email.trim());
        if (existing) body.existing = publicReg(existing);
      }
      return res.status(409).json(body);
    }
    res.json({ ok: true, registration: publicReg(result.registration) });
  } catch (e) { next(e); }
});

// 내 신청 내역 조회 (휴대폰 기준, 이메일도 하위호환 지원)
app.get('/api/lookup', async (req, res, next) => {
  try {
    const phone = (req.query.phone || '').toString().trim();
    const email = (req.query.email || '').toString().trim();
    let reg;
    if (phone) {
      if (phone.replace(/\D/g, '').length < 9)
        return res.status(400).json({ error: '올바른 휴대폰 번호를 입력해 주세요.' });
      reg = await db.getByPhone(phone);
    } else if (email) {
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: '올바른 이메일을 입력해 주세요.' });
      reg = await db.getByEmail(email);
    } else {
      return res.status(400).json({ error: '휴대폰 번호를 입력해 주세요.' });
    }
    if (!reg) return res.status(404).json({ error: CODE_MSG.NOT_FOUND });
    res.json({ registration: publicReg(reg) });
  } catch (e) { next(e); }
});

app.post('/api/update', async (req, res, next) => {
  try {
    const { email, slotId } = req.body || {};
    if (!email || !EMAIL_RE.test(email.trim()))
      return res.status(400).json({ error: '올바른 이메일을 입력해 주세요.' });
    if (!slotId) return res.status(400).json({ error: '변경할 일정을 선택해 주세요.' });

    const result = await db.updateSlot({ email: email.trim(), slotId });
    if (!result.ok) return res.status(409).json({ error: CODE_MSG[result.code], code: result.code });
    res.json({ ok: true, registration: publicReg(result.registration) });
  } catch (e) { next(e); }
});

function publicReg(r) {
  return {
    name: r.name,
    email: r.email,
    phone: r.phone,
    slotId: r.slot_id,
    slotLabel: r.slot_label,
    slotPlace: r.slot_place,
    editCount: r.edit_count,
    canEdit: r.edit_count < 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// --- 관리자 인증 (헤더 비밀번호) ---
function adminAuth(req, res, next) {
  const pw = req.get('x-admin-password') || req.query.pw;
  if (pw !== ADMIN_PASSWORD) return res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
  next();
}

app.get('/api/admin/data', adminAuth, async (req, res, next) => {
  try {
    const search = (req.query.q || '').toString().trim();
    const [slots, list] = await Promise.all([db.slotsWithCounts(), db.allRegistrations(search)]);
    res.json({
      slots,
      registrations: list.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        phone: r.phone,
        slotId: r.slot_id,
        slotLabel: r.slot_label,
        editCount: r.edit_count,
        attended: r.attended,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
      total: list.length,
      attendedTotal: list.filter((r) => r.attended).length,
    });
  } catch (e) { next(e); }
});

// 참석 여부 체크/해제 (출석부)
app.post('/api/admin/attendance', adminAuth, async (req, res, next) => {
  try {
    const { id, attended } = req.body || {};
    if (!id) return res.status(400).json({ error: '대상이 올바르지 않습니다.' });
    const result = await db.setAttendance({ id, attended: !!attended });
    if (!result.ok) return res.status(404).json({ error: '해당 신청 내역을 찾을 수 없습니다.' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 관리자 수동 수강생 추가 (이메일은 선택 입력)
app.post('/api/admin/register', adminAuth, async (req, res, next) => {
  try {
    const { name, email, phone, slotId } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: '이름을 입력해 주세요.' });
    if (!phone || !phone.trim()) return res.status(400).json({ error: '휴대폰 번호를 입력해 주세요.' });
    if (email && email.trim() && !EMAIL_RE.test(email.trim()))
      return res.status(400).json({ error: '올바른 이메일을 입력해 주세요.' });
    if (!slotId) return res.status(400).json({ error: '참석 일정을 선택해 주세요.' });

    const result = await db.adminAdd({
      name: name.trim(),
      email: email ? email.trim() : '',
      phone: phone.trim(),
      slotId,
    });
    if (!result.ok) return res.status(409).json({ error: CODE_MSG[result.code], code: result.code });
    res.json({ ok: true, registration: publicReg(result.registration) });
  } catch (e) { next(e); }
});

// 관리자 신청 정보 수정
app.post('/api/admin/update', adminAuth, async (req, res, next) => {
  try {
    const { id, name, email, phone, slotId } = req.body || {};
    if (!id) return res.status(400).json({ error: '대상이 올바르지 않습니다.' });
    if (!name || !name.trim()) return res.status(400).json({ error: '이름을 입력해 주세요.' });
    if (!phone || !phone.trim()) return res.status(400).json({ error: '휴대폰 번호를 입력해 주세요.' });
    if (email && email.trim() && !EMAIL_RE.test(email.trim()))
      return res.status(400).json({ error: '올바른 이메일을 입력해 주세요.' });
    if (!slotId) return res.status(400).json({ error: '참석 일정을 선택해 주세요.' });

    const result = await db.adminUpdate({
      id,
      name: name.trim(),
      email: email ? email.trim() : '',
      phone: phone.trim(),
      slotId,
    });
    if (!result.ok) return res.status(409).json({ error: CODE_MSG[result.code], code: result.code });
    res.json({ ok: true, registration: publicReg(result.registration) });
  } catch (e) { next(e); }
});

app.get('/api/admin/csv', adminAuth, async (req, res, next) => {
  try {
    const search = (req.query.q || '').toString().trim();
    const slotId = (req.query.slot || '').toString().trim();
    const list = await db.allRegistrations(search, slotId);
    const header = ['이름', '이메일', '휴대폰', '신청일정', '참석여부', '수정여부', '신청일시'];
    const rows = list.map((r) => [
      r.name,
      r.email,
      r.phone,
      r.slot_label,
      r.attended ? '참석' : '미참석',
      r.edit_count >= 1 ? '수정함' : '-',
      new Date(r.created_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
    ]);
    const csv = [header, ...rows]
      .map((cols) => cols.map(csvCell).join(','))
      .join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="registrations.csv"');
    res.send('\uFEFF' + csv); // BOM: 엑셀 한글 깨짐 방지
  } catch (e) { next(e); }
});

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// 오류 핸들러
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
});

db.init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n  챌린지 신청 서버 실행 중 (포트 ${PORT})`);
      console.log(`  신청/수정 : http://localhost:${PORT}/`);
      console.log(`  관리자    : http://localhost:${PORT}/admin\n`);
    });
  })
  .catch((err) => {
    console.error('\n[오류] DB 초기화 실패:', err.message, '\n');
    process.exit(1);
  });
