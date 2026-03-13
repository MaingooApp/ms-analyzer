import { RpcException } from '@nestjs/microservices';

const SUPER_ADMIN_PERMISSION = 'admin.super';

export interface ToolExecutionContext {
  userId: string;
  permissions: string[];
  enterpriseId?: string;
}

export interface ToolRequest<TData> {
  context: ToolExecutionContext;
  data: TData;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const extractToolRequest = <TData>(payload: unknown): ToolRequest<TData> => {
  if (!isRecord(payload) || !('context' in payload) || !('data' in payload)) {
    throw new RpcException({ status: 400, message: 'Invalid tool request payload' });
  }

  const contextValue = payload['context'];

  if (!isRecord(contextValue)) {
    throw new RpcException({ status: 400, message: 'Invalid tool context' });
  }

  const userId = contextValue['userId'];
  const permissions = contextValue['permissions'];
  const enterpriseId = contextValue['enterpriseId'];

  const hasValidUserId = typeof userId === 'string' && userId.length > 0;
  const hasValidPermissions =
    Array.isArray(permissions) &&
    permissions.every((permission) => typeof permission === 'string' && permission.length > 0);
  const hasValidEnterpriseId = enterpriseId === undefined || typeof enterpriseId === 'string';

  if (!hasValidUserId || !hasValidPermissions || !hasValidEnterpriseId) {
    throw new RpcException({ status: 400, message: 'Invalid tool context' });
  }

  return payload as unknown as ToolRequest<TData>;
};

export const requireToolPermission = (
  context: ToolExecutionContext,
  requiredPermission: string,
): void => {
  if (context.permissions.includes(SUPER_ADMIN_PERMISSION)) {
    return;
  }

  if (!context.permissions.includes(requiredPermission)) {
    throw new RpcException({ status: 403, message: `Missing permission: ${requiredPermission}` });
  }
};

export const resolveToolEnterpriseId = (
  context: ToolExecutionContext,
  requestedEnterpriseId?: string,
): string => {
  if (context.permissions.includes(SUPER_ADMIN_PERMISSION)) {
    const enterpriseId = requestedEnterpriseId || context.enterpriseId;
    if (!enterpriseId) {
      throw new RpcException({
        status: 400,
        message: 'enterpriseId is required for admin.super users',
      });
    }
    return enterpriseId;
  }

  if (!context.enterpriseId) {
    throw new RpcException({ status: 403, message: 'User has no enterprise assigned' });
  }

  return context.enterpriseId;
};
