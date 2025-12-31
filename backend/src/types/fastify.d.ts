import '@fastify/jwt';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: {
      sub: string;
      tenantId?: string;
      role?: string;
      type?: 'refresh';
    };
    user: {
      sub: string;
      tenantId: string;
      role: string;
    };
  }
}
