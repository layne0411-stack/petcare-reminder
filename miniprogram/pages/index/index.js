// pages/index/index.js — 任务清单页（自建后端版）
const { request } = require('../../utils/api.js');
const { openModal, modalHandlers, DEFAULT_MODAL } = require('../../utils/ui.js');

/** 任务类型 → 可爱图标 + 配色（按 typeName 关键词匹配） */
const TYPE_STYLES = [
  { kw: '驱虫',   icon: '💊', theme: 'peach'  },
  { kw: '疫苗',   icon: '💉', theme: 'mint'   },
  { kw: '体检',   icon: '🩺', theme: 'butter' },
  { kw: '滤芯',   icon: '🚰', theme: 'mint'   },
  { kw: '干燥剂', icon: '🧂', theme: 'lavender' },
  { kw: '洗澡',   icon: '🛁', theme: 'butter' },
  { kw: '美容',   icon: '✂️', theme: 'lavender' },
  { kw: '粮',     icon: '🥣', theme: 'peach'  }
];
function styleFor(typeName) {
  const hit = TYPE_STYLES.find(t => (typeName || '').includes(t.kw));
  return hit ? { icon: hit.icon, theme: hit.theme } : { icon: '🐾', theme: 'peach' };
}

function greetingNow(nick) {
  const h = new Date().getHours();
  const name = nick || '铲屎官';
  if (h < 5) return `夜深啦，${name} 早点休息～`;
  if (h < 11) return `早上好呀，${name}！`;
  if (h < 14) return `中午好，${name}～`;
  if (h < 18) return `下午好，${name}！`;
  return `晚上好，${name}～`;
}

Page({
  ...modalHandlers,

  data: {
    loading: true,
    modal: Object.assign({}, DEFAULT_MODAL),
    overdueList: [],   // 已到期
    todayList: [],     // 今天到期
    upcomingList: [],  // 未来 7 天内
    laterList: [],     // 更远
    empty: false,
    greeting: '',
    dateText: '',
    todayCount: 0,
    overdueCount: 0,
    focusCount: 0,     // 今日关注 = 逾期 + 今天到期
    pets: [],          // 宠物筛选条
    activePetId: 0     // 0 = 全部
  },

  onShow() {
    this.setData({
      greeting: greetingNow(wx.getStorageSync('nickname')),
      dateText: this.dateText()
    });
    this.loadAll();
  },

  dateText() {
    const d = new Date();
    const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    return `${d.getMonth() + 1}月${d.getDate()}日 · 周${week}`;
  },

  onPullDownRefresh() {
    this.loadAll().finally(() => wx.stopPullDownRefresh());
  },

  /** 同时拉宠物列表和任务列表：宠物用于筛选条，任务用于分组 */
  async loadAll() {
    this.setData({ loading: true });
    try {
      const [petsRes, tasksRes] = await Promise.all([
        request('/api/pets'),
        request('/api/tasks')
      ]);
      this.rawTasks = tasksRes.list || [];
      const pets = (petsRes.list || []).map(p => ({
        id: p.id,
        name: p.name,
        avatar: p.avatarImg ? p.avatarEmoji : p.avatar
      }));
      // 选中的宠物被删掉时自动回到「全部」
      let activePetId = this.data.activePetId;
      if (activePetId && !pets.some(p => p.id === activePetId)) activePetId = 0;
      this.setData({ pets, activePetId });
      this.applyFilter();
    } catch (err) {
      console.error('加载任务失败:', err);
      wx.showToast({ title: '连不上后端，请检查电脑服务与同一 WiFi', icon: 'none' });
      this.setData({ loading: false });
    }
  },

  /** 按当前宠物筛选并分组 */
  applyFilter() {
    const activePetId = this.data.activePetId;
    const all = this.rawTasks || [];
    const list = activePetId ? all.filter(t => t.petId === activePetId) : all;

    const groups = { overdue: [], today: [], upcoming: [], later: [] };
    list.forEach(task => {
      // daysLeft 由服务端按服务器时钟算好返回，前端直接用
      const d = task.daysLeft;
      task.statusText = this.getStatusText(d);
      // 紧急度：决定卡片左侧色条与右上倒计时徽章的配色
      task.urgency = d < 0 ? 'overdue' : d === 0 ? 'today' : d <= 7 ? 'soon' : 'later';
      task.badge = d < 0 ? `逾期 ${-d} 天` : d === 0 ? '今天' : `${d} 天后`;
      const style = styleFor(task.typeName);
      task.icon = style.icon;
      task.theme = style.theme;
      task.titleText =
        (task.petAvatar ? task.petAvatar + ' ' : '') +
        (task.petName ? task.petName + '的' : '') +
        task.typeName;
      if (d < 0) groups.overdue.push(task);
      else if (d === 0) groups.today.push(task);
      else if (d <= 7) groups.upcoming.push(task);
      else groups.later.push(task);
    });
    this.setData({
      overdueList: groups.overdue,
      todayList: groups.today,
      upcomingList: groups.upcoming,
      laterList: groups.later,
      empty: list.length === 0,
      todayCount: groups.today.length,
      overdueCount: groups.overdue.length,
      focusCount: groups.overdue.length + groups.today.length,
      loading: false
    });
  },

  onFilterPet(e) {
    const id = Number(e.currentTarget.dataset.id) || 0;
    if (id === this.data.activePetId) return;
    this.setData({ activePetId: id }, () => this.applyFilter());
  },

  goPets() {
    wx.switchTab({ url: '/pages/pets/pets' });
  },

  getStatusText(days) {
    if (days < 0) return `已逾期 ${-days} 天`;
    if (days === 0) return '今天到期';
    return `剩 ${days} 天`;
  },

  /** 完成打卡：请求订阅授权 + 调服务端完成接口（未到期也允许提前完成，支持补记日期） */
  async onComplete(e) {
    const { id } = e.currentTarget.dataset;
    const task = this.findTask(id);
    if (!task) return;

    const today = this.todayStr();
    const who = `${task.petName ? task.petName + ' ' : ''}${task.typeName}`;
    const early = typeof task.daysLeft === 'number' && task.daysLeft > 0;
    const r = await openModal(this, {
      emoji: early ? '⏰' : '🎉',
      title: early ? '提前打卡' : '完成打卡',
      desc: early
        ? `「${who}」还有 ${task.daysLeft} 天才到期。如果之前做过但忘了记，可以把下面的日期改成实际那天。`
        : `确认已完成「${who}」？完成后下次到期在 ${task.intervalDays} 天后。`,
      confirmText: early ? '提前完成' : '完成啦',
      cancelText: '再想想',
      picker: true,
      pickerLabel: '完成日期',
      pickerValue: today,
      pickerEnd: today
    });
    if (!r.confirm) return;

    // 1. 请求订阅消息授权（必须在用户点击链路里调用），同意后通知服务端加配额
    if (task.remindEnabled) {
      await this.requestSubscribe(task.id);
    }

    // 2. 服务端写记录并按最新记录重算下次到期日
    try {
      const res = await request(`/api/tasks/${id}/complete`, {
        method: 'POST',
        data: { doneDate: r.pickerValue || today }
      });
      if (res.alreadyDone) {
        wx.showToast({ title: `${res.doneDate} 已经打过卡啦`, icon: 'none' });
      } else {
        wx.showToast({ title: `下次：${res.nextDue}`, icon: 'none' });
      }
      this.loadAll();
    } catch (err) {
      console.error('打卡失败:', err);
      const msg = (err && err.detail) || '打卡失败';
      wx.showToast({ title: String(msg).slice(0, 20), icon: 'none' });
    }
  },

  /** 本地今天（YYYY-MM-DD），与服务端北京时区一致即可 */
  todayStr() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  },

  requestSubscribe(taskId) {
    return new Promise(resolve => {
      wx.requestSubscribeMessage({
        tmplIds: [getApp().TEMPLATE_ID],
        success: res => {
          if (res[getApp().TEMPLATE_ID] === 'accept') {
            request('/api/quota', { method: 'POST', data: { taskId } }).catch(console.error);
          }
          resolve();
        },
        fail: err => {
          console.warn('订阅授权失败:', err);
          resolve();
        }
      });
    });
  },

  findTask(id) {
    const all = [
      ...this.data.overdueList,
      ...this.data.todayList,
      ...this.data.upcomingList,
      ...this.data.laterList
    ];
    return all.find(t => t.id === id);
  },

  async onDelete(e) {
    const { id } = e.currentTarget.dataset;
    const r = await openModal(this, {
      emoji: '🗑',
      title: '删除这条护理任务',
      desc: '删除后不再提醒，已经打过的卡会留在记录里。',
      confirmText: '删除',
      cancelText: '取消',
      danger: true
    });
    if (!r.confirm) return;
    try {
      await request(`/api/tasks/${id}`, { method: 'DELETE' });
      this.loadAll();
    } catch (err) {
      console.error('删除失败:', err);
    }
  },

  goEdit(e) {
    wx.navigateTo({ url: `/pages/task-edit/task-edit?id=${e.currentTarget.dataset.id}` });
  },

  goAdd() {
    // 当前筛选了某只宠物时，新建任务默认归给它
    const pid = this.data.activePetId;
    wx.navigateTo({ url: `/pages/task-edit/task-edit${pid ? '?petId=' + pid : ''}` });
  },

  onShareAppMessage() {
    return {
      title: '宠物驱虫体检提醒助手',
      path: '/pages/index/index'
    };
  }
});
