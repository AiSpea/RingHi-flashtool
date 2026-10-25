// ToolBox browser USB/AT simulation. No real hardware access.
module.exports = () => {
      Storage.prototype.setItem = () => {throw Error('No credential persistence');}; indexedDB.open = () => {throw Error('No credential persistence');};
      window.ops = []; window.downloadReady = false;
      class Directory {
        constructor(name = 'backup') {this.name = name;this.files = {};this.dirs = {};}
        async getDirectoryHandle(name, {create} = {}) {if (!this.dirs[name]) {if (!create) throw new DOMException('missing', 'NotFoundError');this.dirs[name] = new Directory(name);}return this.dirs[name];}
        async getFileHandle(name, {create} = {}) {if (!this.files[name]) {if (!create) throw new DOMException('missing', 'NotFoundError');this.files[name] = new Uint8Array();}return {getFile: async () => new Blob([this.files[name]]), createWritable: async () => ({write: async bytes => {this.files[name] = bytes.slice();}, close: async () => {}, abort: async () => {}})};}
      }
      window.disk = new Directory(); window.showDirectoryPicker = async () => disk;
      Object.defineProperty(navigator, 'serial', {value: {addEventListener(){},getPorts: async () => [], requestPort: async () => {
        let controller;return {getInfo: () => ({usbVendorId: 0x3563, usbProductId: 0x2000}), open: async () => {}, close: async () => {},
          readable: new ReadableStream({start(c) {controller = c;}}), writable: new WritableStream({write(bytes) {
            const cmd = new TextDecoder().decode(bytes).trim(); ops.push(cmd); if(cmd==='AT^AUTODL'&&window.failML){controller.enqueue(new TextEncoder().encode('\r\nERROR\r\n'));return;} if (cmd === 'AT^AUTODL') downloadReady = true;
            controller.enqueue(new TextEncoder().encode('\r\nOK\r\n'));
          }})};
      }}});
      let pending, queue = [], buffer = [], crc = true;
      window.resetROM = () => {crc = true;queue = [];buffer = [];downloadReady = false;};
      const answer = b => {if (pending) {const p = pending;pending = null;p.resolve({status: 'ok', data: new DataView(b.buffer, b.byteOffset, b.byteLength)});}else queue.push(b);};
      const alt = {alternateSetting: 0, interfaceClass: 255, endpoints: [{type: 'bulk', direction: 'in', endpointNumber: 1, packetSize: 64}, {type: 'bulk', direction: 'out', endpointNumber: 1, packetSize: 64}]};
      const d = {vendorId: 0x3563, productId: 0x1000, serialNumber: 'mock-device', configuration: {interfaces: [{interfaceNumber: 0, alternate: alt, alternates: [alt]}]}, open: async () => {}, claimInterface: async () => {},
        close: async () => {pending?.reject(Error('closed'));pending = null;},
        transferIn: async () => {if (queue.length) {const b = queue.shift();return {status: 'ok', data: new DataView(b.buffer, b.byteOffset, b.byteLength)};}return new Promise((resolve, reject) => pending = {resolve, reject});},
        transferOut: async (ep, data) => {
          const {frame, u32} = await import('/renderer/upstream/ml307h/protocol.mjs'), b = new Uint8Array(data);
          if (b.length === 3 && b.every(x => x === 126)) {answer(crc ? new TextEncoder().encode('HandshakeROM\r\n') : frame(129, new Uint8Array(), false));return {status: 'ok', bytesWritten: 3};}
          buffer.push(...b);
          if (buffer.length >= 8 && buffer.length === buffer[6] + buffer[7] * 256 + 11) {
            const packet = new Uint8Array(buffer), cmd = packet[4] + packet[5] * 256; buffer = [];ops.push('cmd:' + cmd);
            if (cmd === 16) {downloadReady = false;return {status: 'ok', bytesWritten: b.length};}
            let payload = new Uint8Array(), ack = 128;
            if (cmd === 18) {ack = 131;payload = new Uint8Array(16).fill(7);}
            if (cmd === 32) {ack = 130;payload = u32(32);}
            if (cmd === 33) {ack = 130;payload = new Uint8Array(32).fill(7);}
            if (cmd === 0x47) {ack = 0x48;payload = new TextEncoder().encode('PRODUCT-123\0');}
            if (cmd === 1 && packet.length > 30) ops.push('partition:' + new TextDecoder('utf-16le').decode(packet.slice(8, 80)).replace(/\0/g, ''));
            answer(frame(ack, payload, crc)); if (cmd === 4) crc = false;
          }
          return {status: 'ok', bytesWritten: b.length};
        },
      };
      Object.defineProperty(navigator, 'usb', {value: {getDevices: async () => downloadReady ? [d] : [], requestDevice: async () => d}});
    };
