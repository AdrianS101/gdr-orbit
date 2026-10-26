// No Windows, impede que o computador entre em suspensão enquanto o GDR Digital estiver aberto
// (como um player de vídeo faz). Não muda nenhuma configuração do sistema: vale só enquanto o processo existir.
import { spawn } from 'node:child_process';

export function keepAwake() {
  if (process.platform !== 'win32' || process.env.ORBIT_ALLOW_SLEEP === '1') return;
  const script = `
$sig = '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
$k = Add-Type -MemberDefinition $sig -Name Ka -Namespace Orbit -PassThru
# ES_CONTINUOUS | ES_SYSTEM_REQUIRED: o sistema não suspende; a tela pode desligar normalmente.
while ($true) { [void]$k::SetThreadExecutionState([uint32]"0x80000001"); Start-Sleep -Seconds 50 }`;
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { windowsHide: true, stdio: 'ignore' });
  p.on('error', () => {});
  const stop = () => p.kill();
  process.on('exit', stop);
  process.on('SIGINT', () => (stop(), process.exit(0)));
}
