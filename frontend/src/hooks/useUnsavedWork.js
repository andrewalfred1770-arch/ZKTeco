import { useEffect, useRef } from 'react';
import { registerUnsavedProbe } from '../lib/unsavedWork';

/**
 * Declares that this screen can hold unsaved edits. `isDirty` is called (lazily, never on render) only when a session ends;
 * it must return a boolean and must not expose field values. The latest `isDirty` closure is always used.
 *   useUnsavedWork('employee-form', 'نموذج الموظف', () => formIsModified)
 */
export function useUnsavedWork(id, label, isDirty) {
  const ref = useRef(isDirty);
  ref.current = isDirty;
  useEffect(() => registerUnsavedProbe(id, label, () => !!ref.current()), [id, label]);
}
