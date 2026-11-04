// utils/ui.js — 奶油风自定义弹框（替代 wx.showModal，统一系统 UI 风格）
//
// 用法：
//   const { openModal, modalHandlers, DEFAULT_MODAL } = require('../../utils/ui.js');
//   Page({ ...modalHandlers, data: { modal: DEFAULT_MODAL } })
//   wxml: <import src="../../templates/modal.wxml" /> +
//         <template is="cute-modal" data="{{modal: modal}}" />
//   js:   const { confirm, content } = await openModal(this, { title: '...', desc: '...' });

const DEFAULT_MODAL = {
  show: false,
  emoji: '🐾',
  title: '',
  desc: '',
  confirmText: '确定',
  cancelText: '再想想',
  showCancel: true,
  danger: false,      // true = 危险操作，确认按钮转珊瑚红
  input: false,       // true = 带输入框（替代 showModal editable）
  inputValue: '',
  placeholder: '',
  maxlength: 20,
  picker: false,      // true = 带日期选择（打卡补记 / 记录改日期）
  pickerLabel: '日期',
  pickerValue: '',
  pickerEnd: ''
};

/** 打开弹框，resolve({ confirm, content, pickerValue }) */
function openModal(page, opts) {
  const o = opts || {};
  return new Promise(resolve => {
    page.__modalResolve = resolve;
    page.setData({
      modal: {
        show: true,
        emoji: o.emoji === undefined ? DEFAULT_MODAL.emoji : o.emoji,
        title: o.title || '',
        desc: o.desc || '',
        confirmText: o.confirmText || '确定',
        cancelText: o.cancelText || '再想想',
        showCancel: o.showCancel !== false,
        danger: !!o.danger,
        input: !!o.input,
        inputValue: o.inputValue || '',
        placeholder: o.placeholder || '',
        maxlength: o.maxlength || 20,
        picker: !!o.picker,
        pickerLabel: o.pickerLabel || '日期',
        pickerValue: o.pickerValue || '',
        pickerEnd: o.pickerEnd || ''
      }
    });
  });
}

function closeModal(page, confirm) {
  const m = page.data.modal || {};
  const content = m.inputValue || '';
  const pickerValue = m.pickerValue || '';
  page.setData({ 'modal.show': false });
  const resolve = page.__modalResolve;
  page.__modalResolve = null;
  if (resolve) resolve({ confirm: !!confirm, content, pickerValue });
}

/** 展开进 Page 定义即可获得弹框所需的事件处理 */
const modalHandlers = {
  onModalConfirm() { closeModal(this, true); },
  onModalCancel() { closeModal(this, false); },
  onModalInput(e) { this.setData({ 'modal.inputValue': e.detail.value }); },
  onModalPickerChange(e) { this.setData({ 'modal.pickerValue': e.detail.value }); },
  noop() {}
};

module.exports = { openModal, closeModal, modalHandlers, DEFAULT_MODAL };
