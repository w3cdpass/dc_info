// Role types for RBAC
export type UserRole = 'admin' | 'operator' | 'viewer' | 'demo' | 'super_admin';

export interface RoleContextType {
  role: UserRole | null;
  setRole: (role: UserRole | null) => void;
  isAdmin: boolean;
  isOperator: boolean;
  isViewer: boolean;
  isDemo: boolean;
  canWrite: boolean;
}
