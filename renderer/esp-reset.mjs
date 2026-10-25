// ESP32-S3 native USB can retain download straps after an RTS-only reset.
// Espressif's S3 watchdog reset restarts the whole chip and re-samples straps:
// https://github.com/espressif/esptool/blob/master/esptool/targets/esp32s3.py
export async function resetEsp(loader,transport,sleep=ms=>new Promise(r=>setTimeout(r,ms))){
 const info=transport?.device?.getInfo?.()||{};
 if(loader.chip?.CHIP_NAME==='ESP32-S3'&&info.usbVendorId===0x303a&&info.usbProductId===0x1001){
  // Volatile RTC registers only: never eFuses or flash. Keep failures visible.
  await loader.writeReg(0x6000812c,0,1); // Clear FORCE_DOWNLOAD_BOOT only.
  await loader.writeReg(0x600080b0,0x50d83aa1); // Unlock RTC watchdog.
  await loader.writeReg(0x6000809c,2000);
  await loader.writeReg(0x60008098,0xd0000102); // RTC + main-system reset.
  await loader.writeReg(0x600080b0,0);
  await sleep(500);
 }else await loader.after('hard_reset');
}
