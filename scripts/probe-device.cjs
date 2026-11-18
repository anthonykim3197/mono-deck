// Read-only HID inventory, device information and all three stored layers.
const HID = require('node-hid');
const fs = require('node:fs');
const path = require('node:path');
const devices = HID.devices(0x1189, 0x8840);
console.log(JSON.stringify(devices, null, 2));
const candidate = devices.find(d => d.usagePage === 0xff00 && d.usage === 1 && d.interface === 0);
if (!candidate) throw new Error('1189:8840 vendor interface is not connected');
const device = new HID.HID(candidate.path);
const records = [];
function exchange(bytes, max = 30) {
  const packet = Buffer.alloc(65); Buffer.from(bytes).copy(packet);
  console.log('TX', packet.subarray(0, 14).toString('hex'));
  const written = device.write(Array.from(packet));
  const responses = [];
  for (let i = 0; i < max; i++) {
    const data = device.readTimeout(i === 0 ? 1200 : 120);
    if (!data.length) break;
    responses.push(data);
    console.log('RX', Buffer.from(data).toString('hex'));
  }
  records.push({ request: [...packet], written, responses });
}
try {
  exchange([3, 0xfb, 0xfb, 0xfb]);
  for (const layer of [1, 2, 3]) exchange([3, 0xfa, 15, 3, layer]);
} finally { device.close(); }
const out = path.resolve('.local/evidence'); fs.mkdirSync(out, { recursive: true });
const report = { observedAt: new Date().toISOString(), platform: process.platform, devices, records };
fs.writeFileSync(path.join(out, 'device-readback.json'), JSON.stringify(report, null, 2));
console.log('Saved read-only evidence to .local/evidence/device-readback.json');
