// pages/history/history.js — 完成记录（时间轴版：护理打卡 + 体重记录汇入同一条时间线）
const { request } = require('../../utils/api.js');
const { openModal, modalHandlers, DEFAULT_MODAL } = require('../../utils/ui.js');

/** 与首页一致的类型图标映射 */
const TYPE_ICONS = [
  { kw: '驱虫', icon: '💊', theme: 'peach' },
  { kw: '疫苗', icon: '💉', theme: 'mint' },
  { kw: '体检', icon: '🩺', theme: 'butter' },
  { kw: '滤芯', icon: '🚰', theme: 'mint' },
  { kw: '干燥剂', icon: '🧂', theme: 'lavender' },
  { kw: '洗澡', icon: '🛁', theme: 'butter' },
  { kw: '美容', icon: '✂️', theme: 'lavender' },
  { kw: '粮', icon: '🥣', theme: 'peach' }
];

function styleFor(typeName) {
  const hit = TYPE_ICONS.find(t => (typeName || '').includes(t.kw));
  return hit ? { icon: hit.icon, theme: hit.theme } : { icon: '🐾', theme: 'peach' };
}

Page({
  ...modalHandlers,

  data: {
    loading: true,
    modal: Object.assign({}, DEFAULT_MODAL),
    groups: [],       // 时间轴分组：[{ date, label, isToday, items:[…] }]
    empty: false,
    pets: [],
    activePetId: 0,   // 0 = 全部
    typeChips: [],
    activeType: '',   // '' = 全部类型
    total: 0,
    monthCount: 0,    // 本月记录数
    streak: 0,        // 连续打卡天数
    weightEvents: []  // 体重事件（按宠物筛选时保留，选了具体类型则不展示）
  },

  onShow() {
    this.loadAll();
  },

  onPullDownRefresh() {
    this.loadAll().finally(() => wx.stopPullDownRefresh());
  },

  async loadAll() {
    this.setData({ loading: true });
    try {
      const [petsRes, recordsRes] = await Promise.all([
        request('/api/pets'),
        request('/api/records')
      ]);
      const rawRecords = (recordsRes.list || []).map(r => {
        const s = styleFor(r.typeName);
        r.icon = s.icon;
        r.theme = s.theme;
        r.kind = 'record';
        r.date = r.doneDate;   // 统一字段名，方便与体重事件一起按日期排序分组
        r.titleText =
          (r.petAvatar ? r.petAvatar + ' ' : '') +
          (r.petName ? r.petName + '的' : '') +
          r.typeName;
        return r;
      });
      this.rawRecords = rawRecords;

      const pets = (petsRes.list || []).map(p => ({ id: p.id, name: p.name, avatar: p.avatar }));

      // 类型筛选：只展示实际出现过的类型，最多 8 个
      const types = [];
      rawRecords.forEach(r => {
        if (r.typeName && !types.includes(r.typeName)) types.push(r.typeName);
      });

      let activePetId = this.data.activePetId;
      if (activePetId && !pets.some(p => p.id === activePetId)) activePetId = 0;
      let activeType = this.data.activeType;
      if (activeType && !types.includes(activeType)) activeType = '';

      // 拉全部体重记录（每只宠物一次请求），汇入时间轴
      let weightEvents = [];
      try {
        const weightLists = await Promise.all(
          pets.map(p =>
            request(`/api/pets/${p.id}/weights`)
              .then(res => (res.list || []).map(w => ({ ...w, petId: p.id, petName: p.name, petAvatar: p.avatar, kind: 'weight' })))
              .catch(() => [])
          )
        );
        weightEvents = weightLists.flat();
      } catch (e) {
        console.warn('体重数据拉取失败，时间轴仅展示打卡记录:', e);
      }
      this.weightEvents = weightEvents;

      // 顶部统计：累计 / 本月 / 连续天数
      const today = this.todayStr();
      const monthPrefix = today.slice(0, 7);
      const monthCount = rawRecords.filter(r => (r.doneDate || '').slice(0, 7) === monthPrefix).length;

      this.setData({
        pets,
        activePetId,
        typeChips: types.slice(0, 8),
        activeType,
        total: rawRecords.length,
        monthCount,
        streak: this.calcStreak(rawRecords, today)
      });
      this.applyFilter();
    } catch (err) {
      console.error('加载记录失败:', err);
      wx.showToast({ title: '加载失败', icon: 'none' });
      this.setData({ loading: false });
    }
  },

  /** 连续打卡天数：从今天（或昨天）往前数，每天都至少有一次打卡 */
  calcStreak(records, today) {
    const days = new Set(records.map(r => r.doneDate));
    if (!days.size) return 0;
    const d = new Date(today + 'T00:00:00');
    if (!days.has(today)) d.setDate(d.getDate() - 1); // 今天还没打，从昨天起算
    let streak = 0;
    while (days.has(this.fmtDate(d))) {
      streak++;
      d.setDate(d.getDate() - 1);
    }
    return streak;
  },

  fmtDate(d) {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  },

  applyFilter() {
    const { activePetId, activeType } = this.data;
    let list = this.rawRecords || [];
    let weights = this.weightEvents || [];
    if (activePetId) {
      list = list.filter(r => r.petId === activePetId);
      weights = weights.filter(w => w.petId === activePetId);
    }
    if (activeType) {
      list = list.filter(r => r.typeName === activeType);
      weights = []; // 选了具体护理类型时，时间轴只看这类打卡
    }

    // 合并为事件流，按日期倒序分组
    const events = [...list, ...weights];
    const today = this.todayStr();
    const week = ['日', '一', '二', '三', '四', '五', '六'];
    const groups = [];
    events
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.id || 0) - (a.id || 0)))
      .forEach(ev => {
        ev.key = ev.kind + '-' + ev.id;
        if (ev.kind === 'weight') {
          ev.icon = '⚖️';
          ev.theme = 'mint';
          ev.titleText = (ev.petAvatar ? ev.petAvatar + ' ' : '') + ev.petName + '的体重';
        }
        let g = groups.find(x => x.date === ev.date);
        if (!g) {
          const dd = new Date(ev.date + 'T00:00:00');
          const suffix = ev.date === today ? ' · 今天' : ev.date === this.fmtDate(new Date(Date.now() - 86400000)) ? ' · 昨天' : ` · 周${week[dd.getDay()]}`;
          g = { date: ev.date, label: `${Number(ev.date.slice(5, 7))}月${Number(ev.date.slice(8, 10))}日${suffix}`, isToday: ev.date === today, items: [] };
          groups.push(g);
        }
        g.items.push(ev);
      });

    this.setData({ groups, empty: events.length === 0, loading: false });
  },

  onFilterPet(e) {
    const id = Number(e.currentTarget.dataset.id) || 0;
    if (id === this.data.activePetId) return;
    this.setData({ activePetId: id }, () => this.applyFilter());
  },

  onFilterType(e) {
    const t = e.currentTarget.dataset.type || '';
    if (t === this.data.activeType) return;
    this.setData({ activeType: t }, () => this.applyFilter());
  },

  /** 修改这条记录的日期 */
  async onEditDate(e) {
    const id = Number(e.currentTarget.dataset.id);
    const rec = (this.rawRecords || []).find(r => r.id === id);
    if (!rec) return;
    const r = await openModal(this, {
      emoji: '📅',
      title: '改一下完成日期',
      desc: `${rec.petName ? rec.petName + ' 的' : ''}${rec.typeName}，改完会同时重算下次到期日`,
      confirmText: '保存',
      cancelText: '取消',
      picker: true,
      pickerLabel: '完成日期',
      pickerValue: rec.doneDate,
      pickerEnd: this.todayStr()
    });
    if (!r.confirm || r.pickerValue === rec.doneDate) return;
    try {
      await request(`/api/records/${id}`, { method: 'PUT', data: { doneDate: r.pickerValue } });
      wx.showToast({ title: '已更新', icon: 'success' });
      this.loadAll();
    } catch (err) {
      const msg = (err && err.detail) || '修改失败';
      wx.showToast({ title: String(msg).slice(0, 20), icon: 'none' });
    }
  },

  /** 删除这条记录（等于撤销这次打卡） */
  async onDeleteRecord(e) {
    const id = Number(e.currentTarget.dataset.id);
    const rec = (this.rawRecords || []).find(r => r.id === id);
    if (!rec) return;
    const r = await openModal(this, {
      emoji: '🗑',
      title: '撤销这次打卡？',
      desc: `删除后「${rec.typeName}」的下次到期日会回退到上一条记录。`,
      confirmText: '删除',
      cancelText: '保留',
      danger: true
    });
    if (!r.confirm) return;
    try {
      await request(`/api/records/${id}`, { method: 'DELETE' });
      wx.showToast({ title: '已撤销', icon: 'success' });
      this.loadAll();
    } catch (err) {
      console.error('删除记录失败:', err);
      wx.showToast({ title: '删除失败', icon: 'none' });
    }
  },

  /** 删除体重记录 */
  async onDeleteWeight(e) {
    const id = Number(e.currentTarget.dataset.id);
    const w = (this.weightEvents || []).find(x => x.id === id && x.kind === 'weight');
    if (!w) return;
    const r = await openModal(this, {
      emoji: '🗑',
      title: '删除这条体重记录？',
      desc: `${w.petName} ${w.date} 的 ${w.weight} kg 记录将被删除。`,
      confirmText: '删除',
      cancelText: '保留',
      danger: true
    });
    if (!r.confirm) return;
    try {
      await request(`/api/weights/${id}`, { method: 'DELETE' });
      wx.showToast({ title: '已删除', icon: 'success' });
      this.loadAll();
    } catch (err) {
      console.error('删除体重记录失败:', err);
      wx.showToast({ title: '删除失败', icon: 'none' });
    }
  },

  todayStr() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  }
});
