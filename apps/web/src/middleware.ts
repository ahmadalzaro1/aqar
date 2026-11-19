import { NextResponse, type NextRequest } from 'next/server';

const PROTECTED = ['/dashboard', '/portfolio', '/leasing', '/leases', '/ledger', '/tickets', '/vendors', '/owners', '/documents', '/reports', '/settings'];

export function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (PROTECTED.some((p) => path === p || path.startsWith(`${p}/`))) {
    const session = req.cookies.get('aqar_session')?.value;
    if (session === undefined) {
      const url = req.nextUrl.clone();
      url.pathname = '/login';
      return NextResponse.redirect(url);
    }
  }
  return NextResponse.next();
}

export const config = { matcher: ['/((?!_next|favicon|api/public).*)'] };
