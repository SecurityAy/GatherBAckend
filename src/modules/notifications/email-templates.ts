export type TicketEmailBlock = {
  ticketId?: string;
  attendeeId?: string;
  attendeeName: string;
  qrToken: string;
  ticketUrl?: string;
};

type RsvpNotificationEmail = {
  type: 'ORGANISER_NEW_RSVP' | 'GUEST_RSVP_RECEIVED' | 'GUEST_RSVP_APPROVED' | 'GUEST_RSVP_DECLINED';
  recipientEmail: string;
  guestName: string;
  guestEmail: string;
  eventName: string;
  attendanceIntent: 'ATTENDING' | 'NOT_ATTENDING';
  status: string;
  eventDate?: string | null;
  venue?: string | null;
  dashboardUrl?: string;
  invitationUrl?: string;
  /** Added to approval emails only; existing messages keep their original layout. */
  ticket?: TicketEmailBlock;
};

type PasswordResetNotificationEmail = {
  type: 'PASSWORD_RESET';
  recipientEmail: string;
  recipientName: string;
  resetUrl: string;
  expiresAt: string;
};

type TicketDeliveryNotificationEmail = {
  type: 'TICKET_DELIVERY';
  recipientEmail: string;
  recipientName: string;
  eventName: string;
  eventDate?: string | null;
  venue?: string | null;
  invitationUrl?: string;
  ticket: TicketEmailBlock;
};

export type NotificationEmail = RsvpNotificationEmail | PasswordResetNotificationEmail | TicketDeliveryNotificationEmail;

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

function ticketAccess(ticket: TicketEmailBlock) {
  return ticket.ticketUrl ?? ticket.qrToken;
}

function wrapEmail(title: string, htmlBody: string) {
  return `<!doctype html><html><body style="margin:0;background:#f5f3ee;font-family:Arial,sans-serif;color:#292d28"><table role="presentation" width="100%"><tr><td align="center" style="padding:32px 12px"><table role="presentation" width="600" style="max-width:600px;background:#fff;border-radius:16px"><tr><td style="padding:32px"><div style="color:#71826b;font-weight:bold;letter-spacing:3px">GATHER</div><h1 style="font-size:26px">${escapeHtml(title)}</h1>${htmlBody}<p style="color:#73766f">With joy in our hearts,<br>Gather</p></td></tr></table></td></tr></table></body></html>`;
}

function renderPasswordResetEmail(data: PasswordResetNotificationEmail) {
  const title = 'Reset your Gather password';
  const text = `Hello ${data.recipientName},\n\nUse the link below to reset your Gather password.\nReset password: ${data.resetUrl}\nThis link expires at ${data.expiresAt}.\n\nIf you did not request this change, you can ignore this email.\n\nGather`;
  const html = wrapEmail(title,
    `<p>Hello ${escapeHtml(data.recipientName)},</p><p>Use the link below to reset your Gather password.</p><p><a style="display:inline-block;background:#292d28;color:white;padding:12px 18px;border-radius:8px;text-decoration:none" href="${escapeHtml(data.resetUrl)}">Reset password</a></p><p style="color:#73766f">This link expires at ${escapeHtml(data.expiresAt)}. If you did not request this change, you can ignore this email.</p>`);
  return { subject: title, html, text };
}

function renderTicketDeliveryEmail(data: TicketDeliveryNotificationEmail) {
  const title = `Your ticket for ${data.eventName}`;
  const access = ticketAccess(data.ticket);
  const details = [data.eventDate, data.venue].filter((value): value is string => Boolean(value)).map(escapeHtml).join(' · ');
  const text = `${title}\n\nHello ${data.recipientName},\nYour ticket is ready for ${data.eventName}.\n${data.ticket.attendeeName}${details ? `\n${details}` : ''}\nOpen your ticket: ${access}${data.invitationUrl ? `\nEvent details: ${data.invitationUrl}` : ''}\n\nGather`;
  const ticketLink = `<p><a style="display:inline-block;background:#292d28;color:white;padding:12px 18px;border-radius:8px;text-decoration:none" href="${escapeHtml(access)}">Open your ticket</a></p>`;
  const invitationLink = data.invitationUrl
    ? `<p><a href="${escapeHtml(data.invitationUrl)}">View event details</a></p>`
    : '';
  const html = wrapEmail(title,
    `<p>Hello ${escapeHtml(data.recipientName)},</p><p>Your ticket is ready for <strong>${escapeHtml(data.eventName)}</strong>.</p><p>${escapeHtml(data.ticket.attendeeName)}</p>${details ? `<p>${details}</p>` : ''}${ticketLink}${invitationLink}`);
  return { subject: title, html, text };
}

export function renderNotificationEmail(data: NotificationEmail) {
  if (data.type === 'PASSWORD_RESET') return renderPasswordResetEmail(data);
  if (data.type === 'TICKET_DELIVERY') return renderTicketDeliveryEmail(data);

  // Existing RSVP messages keep their subject, text, and HTML layout byte-for-byte
  // unless a ticket block is explicitly supplied.
  const rsvp = data;
  const attending = rsvp.attendanceIntent === 'ATTENDING';
  const subject = rsvp.type === 'ORGANISER_NEW_RSVP' ? `New RSVP for ${rsvp.eventName}`
    : rsvp.type === 'GUEST_RSVP_RECEIVED' ? `We received your RSVP for ${rsvp.eventName}`
      : rsvp.type === 'GUEST_RSVP_APPROVED' ? `Your attendance is approved for ${rsvp.eventName}`
        : `An update about your RSVP for ${rsvp.eventName}`;
  const acknowledgement = rsvp.status === 'PENDING'
    ? 'Your RSVP was received and is awaiting organiser approval.'
    : rsvp.status === 'APPROVED'
      ? 'Your RSVP is approved.'
      : rsvp.status === 'NOT_REQUIRED'
        ? 'Your response was recorded as not attending; no approval is required.'
        : undefined;
  const response = rsvp.type === 'GUEST_RSVP_RECEIVED' && acknowledgement
    ? acknowledgement
    : attending ? `Attending · ${rsvp.status}` : 'Not attending';
  const title = rsvp.type === 'ORGANISER_NEW_RSVP' ? 'A new RSVP has arrived'
    : rsvp.type === 'GUEST_RSVP_RECEIVED' ? (rsvp.status === 'PENDING' ? 'Your RSVP was received and is awaiting organiser approval' : rsvp.status === 'APPROVED' ? 'Your RSVP is approved' : 'Your response was recorded; no approval is required')
      : rsvp.type === 'GUEST_RSVP_APPROVED' ? 'Your attendance is approved' : 'Your RSVP was declined';
  const details = [rsvp.eventDate, rsvp.venue].filter((value): value is string => Boolean(value)).map(escapeHtml).join(' · ');
  const link = rsvp.type === 'ORGANISER_NEW_RSVP' ? rsvp.dashboardUrl : rsvp.invitationUrl;
  const linkLabel = rsvp.type === 'ORGANISER_NEW_RSVP' ? 'Review RSVPs' : 'View event details';
  const ticketAccessLine = rsvp.ticket ? `\nTicket for ${rsvp.ticket.attendeeName}: ${ticketAccess(rsvp.ticket)}` : '';
  const ticketHtml = rsvp.ticket
    ? `<p><strong>Your ticket</strong><br>${escapeHtml(rsvp.ticket.attendeeName)}<br><a style="display:inline-block;background:#71826b;color:white;padding:12px 18px;border-radius:8px;text-decoration:none" href="${escapeHtml(ticketAccess(rsvp.ticket))}">Open your ticket</a></p>`
    : '';
  const text = `${title}\n\n${rsvp.guestName} · ${rsvp.eventName}\n${response}${details ? `\n${details}` : ''}${link ? `\n${linkLabel}: ${link}` : ''}${ticketAccessLine}\n\nGather`;
  const html = `<!doctype html><html><body style="margin:0;background:#f5f3ee;font-family:Arial,sans-serif;color:#292d28"><table role="presentation" width="100%"><tr><td align="center" style="padding:32px 12px"><table role="presentation" width="600" style="max-width:600px;background:#fff;border-radius:16px"><tr><td style="padding:32px"><div style="color:#71826b;font-weight:bold;letter-spacing:3px">GATHER</div><h1 style="font-size:26px">${escapeHtml(title)}</h1><p>Hello ${escapeHtml(rsvp.guestName)},</p><p><strong>${escapeHtml(rsvp.eventName)}</strong></p><p>${escapeHtml(response)}</p>${details ? `<p>${details}</p>` : ''}${link ? `<p><a style="display:inline-block;background:#292d28;color:white;padding:12px 18px;border-radius:8px;text-decoration:none" href="${escapeHtml(link)}">${linkLabel}</a></p>` : ''}${ticketHtml}<p style="color:#73766f">With joy in our hearts,<br>Gather</p></td></tr></table></td></tr></table></body></html>`;
  return { subject, html, text };
}
