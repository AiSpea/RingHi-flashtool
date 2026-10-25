$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
# Query SetupAPI / Configuration Manager directly. PnpDevice CIM calls can stall
# in a non-elevated interactive desktop session even when SSH enumeration works.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class RingHiPorts {
 [StructLayout(LayoutKind.Sequential)] struct Info { public int Size; public Guid ClassGuid; public uint DevInst; public IntPtr Reserved; }
 [StructLayout(LayoutKind.Sequential)] struct Key { public Guid Fmt; public uint Pid; public Key(uint pid) { Fmt=new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"); Pid=pid; } }
 [DllImport("setupapi.dll",CharSet=CharSet.Unicode)] static extern IntPtr SetupDiGetClassDevs(ref Guid guid,string enumerator,IntPtr parent,uint flags);
 [DllImport("setupapi.dll",SetLastError=true)] static extern bool SetupDiEnumDeviceInfo(IntPtr set,uint index,ref Info info);
 [DllImport("setupapi.dll")] static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
 [DllImport("cfgmgr32.dll",CharSet=CharSet.Unicode)] static extern uint CM_Get_DevNode_PropertyW(uint node,ref Key key,out uint type,byte[] buffer,ref uint size,uint flags);
 [DllImport("cfgmgr32.dll",CharSet=CharSet.Unicode)] static extern uint CM_Get_Device_IDW(uint node,StringBuilder buffer,uint length,uint flags);
 [DllImport("cfgmgr32.dll")] static extern uint CM_Get_Parent(out uint parent,uint node,uint flags);
 static string Property(uint node,uint pid) { var key=new Key(pid);uint type;uint size=0;var rc=CM_Get_DevNode_PropertyW(node,ref key,out type,null,ref size,0);if(size==0||size>65536)return "";var bytes=new byte[size];if(CM_Get_DevNode_PropertyW(node,ref key,out type,bytes,ref size,0)!=0)return "";return Encoding.Unicode.GetString(bytes).TrimEnd('\0'); }
 static string Id(uint node) { var text=new StringBuilder(1024);return CM_Get_Device_IDW(node,text,1024,0)==0?text.ToString():""; }
 public class Port { public string path; public string instance; public string[] locations; public int? iface; }
 public static Port[] Read() {
  var list=new List<Port>();var guid=new Guid("4d36e978-e325-11ce-bfc1-08002be10318");var set=SetupDiGetClassDevs(ref guid,null,IntPtr.Zero,2);
  if(set==new IntPtr(-1))throw new Exception("Cannot enumerate present serial ports");
  try {for(uint index=0;;index++) { var info=new Info();info.Size=Marshal.SizeOf(typeof(Info));if(!SetupDiEnumDeviceInfo(set,index,ref info)){var error=Marshal.GetLastWin32Error();if(error!=259)throw new System.ComponentModel.Win32Exception(error);break;}
   var match=System.Text.RegularExpressions.Regex.Match(Property(info.DevInst,14),@"\((COM\d+)\)",System.Text.RegularExpressions.RegexOptions.IgnoreCase);if(!match.Success)continue;
   var node=info.DevInst;var id=Id(node);var im=System.Text.RegularExpressions.Regex.Match(id,@"&MI_([0-9A-F]{2})",System.Text.RegularExpressions.RegexOptions.IgnoreCase);int? iface=im.Success?(int?)Convert.ToInt32(im.Groups[1].Value,16):null;
   string[] locations=new string[0];
   for(int depth=0;depth<10;depth++) {id=Id(node);var loc=Property(node,37);if(loc.IndexOf("#USB(",StringComparison.OrdinalIgnoreCase)>=0)locations=loc.Split(new char[]{'\0'},StringSplitOptions.RemoveEmptyEntries);
    if(System.Text.RegularExpressions.Regex.IsMatch(id,@"^USB\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}",System.Text.RegularExpressions.RegexOptions.IgnoreCase)&&id.IndexOf("&MI_",StringComparison.OrdinalIgnoreCase)<0) {if(locations.Length>0)list.Add(new Port{path=match.Groups[1].Value,instance=id,locations=locations,iface=iface});break;}
    uint parent;if(CM_Get_Parent(out parent,node,0)!=0)break;node=parent;
   }
  }}finally{SetupDiDestroyDeviceInfoList(set);}return list.ToArray();
 }
}
'@
ConvertTo-Json -InputObject @([RingHiPorts]::Read()) -Depth 5 -Compress
