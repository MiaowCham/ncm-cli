export function hasProcessExited(child) {
  return !child || child.exitCode != null || child.signalCode != null;
}
