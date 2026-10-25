// Official FUT FEATURE ACTIVE sequence. No credentials or license material on disk.
const encoder = new TextEncoder();
export function productCode(payload) {
  if (!(payload instanceof Uint8Array) || !payload.length || payload.length > 4097) throw Error('设备产品标识长度无效');
  const end = payload.indexOf(0), data = end < 0 ? payload : payload.subarray(0, end);
  if (end >= 0 && payload.subarray(end).some(byte => byte !== 0)) throw Error('设备产品标识包含非预期数据');
  if (!data.length || data.length > 4096 || data.some(byte => byte < 32 || byte > 126)) throw Error('设备产品标识格式无效');
  return new TextDecoder().decode(data);
}
function wire(value) {
  if (typeof value !== 'string' || !/^[\x20-\x7e]{1,65535}$/.test(value)) throw Error('官方激活材料格式无效');
  return encoder.encode(value);
}

export async function prepareActivation({api, token, project, isCurrent = () => true, onStage = () => {}}) {
  if (!token || !Number.isInteger(project?.project_id) || project.project_id < 1) throw Error('请先登录官方账号并选择授权项目');
  const projectId = project.project_id, name = project.name;
  let keys = null, privateKey = null, used = false, disposed = false;
  function current() { if (disposed || !isCurrent()) throw Error('官方账号或授权项目已变化，请重新准备下载'); }
  function dispose() { disposed = true; token = ''; keys = null; privateKey = null; }
  try {
    current(); onStage('正在准备所选项目的激活材料…');
    keys = await api('project-keys', {token, project_id: projectId}); current();
    privateKey = await api('private-key', {token, project_id: projectId}); current();
    for (const value of [keys.AES, keys.rsa_n, keys.rsa_e, privateKey.rsa_d]) wire(value);
  } catch (error) { dispose(); throw error; }
  return {
    dispose,
    async run(dl, store) {
      if (used) throw Error('本次激活已执行过，禁止自动重复领取授权');
      used = true;
      // A persisted attempt must never be replayed, including after a page reload.
      if (store.state.activation) { dispose(); throw Error('此烧录记录已有激活尝试，请先在官方平台核对结果'); }
      const record = {project_id: projectId, project_name: name, status: 'preparing', device_written: false, started_at: new Date().toISOString()};
      store.state.activation = record;
      const stage = async (status, text) => { record.status = status; await store.saveState(); onStage(text); };
      const send = (cmd, payload = new Uint8Array(), ok = [0x80]) => dl.transaction(cmd, payload, {ok, timeout: 3000});
      let license = null, third = null;
      try {
        current(); await stage('device-preparing', '固件下载完成 · 正在初始化功能激活');
        await send(0x42); await send(0x49, crypto.getRandomValues(new Uint8Array(32)));
        for (const [cmd, value] of [[0x43, keys.AES], [0x44, keys.rsa_n], [0x45, keys.rsa_e], [0x46, privateKey.rsa_d]]) await send(cmd, wire(value));
        keys = null; privateKey = null;
        const cpucode = productCode((await send(0x47, new Uint8Array(), [0x48])).payload);
        current(); await stage('key-requesting', '正在向官方领取本设备授权，请勿重复操作');
        license = await api('activation-key', {token, project_id: projectId, cpucode}); current();
        const main = wire(license.cdkey);
        await stage('device-writing', '正在写入设备功能授权');
        try { await send(0x4a, main); } finally { main.fill(0); }
        if (license.has3rd) {
          await stage('third-party-requesting', '正在获取本项目的第三方授权'); current();
          third = await api('third-party-key', {token, project_id: projectId, cpucode}); current();
          const extra = wire(third.cdkey);
          await stage('third-party-writing', '正在写入第三方功能授权');
          try { await send(0x4b, extra); } finally { extra.fill(0); }
        }
        record.device_written = true;
        await stage('reporting', '设备授权已写入 · 正在向官方确认结果'); current();
        const report = await api('activation-report', {token, project_id: projectId, cpucode});
        if (report.reported !== true) throw Error('官方未确认激活结果');
        await stage('complete', '功能激活完成');
        record.completed_at = new Date().toISOString(); await store.saveState();
        return {project_id: projectId, surplus: license.surplus};
      } catch (error) {
        const last = record.status;
        record.status = record.device_written ? 'device-complete-report-unconfirmed' : 'unconfirmed';
        record.stopped_at = last;
        try { await store.saveState(); } catch { /* Preserve the original failure without retrying device/API writes. */ }
        throw Object.assign(Error(record.device_written ? '固件下载完成；设备授权已写入，但官方上报未确认。请在官方平台核对，本页不会自动重试。' : '固件下载完成；功能激活未完成或结果待核对。请保留备份并在官方平台核对授权，本页不会自动重试。'), {code: error.code});
      } finally { license = null; third = null; dispose(); }
    },
  };
}
