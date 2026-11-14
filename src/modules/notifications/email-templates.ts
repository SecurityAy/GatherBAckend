export type NotificationEmail = {
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
};

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export function renderNotificationEmail(data: NotificationEmail) {
  const attending = data.attendanceIntent === 'ATTENDING';
  const subject = data.type === 'ORGANISER_NEW_RSVP' ? `New RSVP for ${data.eventName}`
    : data.type === 'GUEST_RSVP_RECEIVED' ? `We received your RSVP for ${data.eventName}`
      : data.type === 'GUEST_RSVP_APPROVED' ? `Your attendance is approved for ${data.eventName}`
        : `An update about your RSVP for ${data.eventName}`;
  const acknowledgement = data.status === 'PENDING'
    ? 'Your RSVP was received and is awaiting organiser approval.'
    : data.status === 'APPROVED'
      ? 'Your RSVP is approved.'
      : data.status === 'NOT_REQUIRED'
        ? 'Your response was recorded as not attending; no approval is required.'
        : undefined;
  const response = data.type === 'GUEST_RSVP_RECEIVED' && acknowledgement
    ? acknowledgement
    : attending ? `Attending · ${data.status}` : 'Not attending';
  const title = data.type === 'ORGANISER_NEW_RSVP' ? 'A new RSVP has arrived'
    : data.type === 'GUEST_RSVP_RECEIVED' ? (data.status === 'PENDING' ? 'Your RSVP was received and is awaiting organiser approval' : data.status === 'APPROVED' ? 'Your RSVP is approved' : 'Your response was recorded; no approval is required')
      : data.type === 'GUEST_RSVP_APPROVED' ? 'Your attendance is approved' : 'Your RSVP was declined';
  const details = [data.eventDate, data.venue].filter((value): value is string => Boolean(value)).map(escapeHtml).join(' · ');
  const link = data.type === 'ORGANISER_NEW_RSVP' ? data.dashboardUrl : data.invitationUrl;
  const linkLabel = data.type === 'ORGANISER_NEW_RSVP' ? 'Review RSVPs' : 'View event details';
  const text = `${title}\n\n${data.guestName} · ${data.eventName}\n${response}${details ? `\n${details}` : ''}${link ? `\n${linkLabel}: ${link}` : ''}\n\nGather`;
  const html = `<!doctype html><html><body style="margin:0;background:#f5f3ee;font-family:Arial,sans-serif;color:#292d28"><table role="presentation" width="100%"><tr><td align="center" style="padding:32px 12px"><table role="presentation" width="600" style="max-width:600px;background:#fff;border-radius:16px"><tr><td style="padding:32px"><div style="color:#71826b;font-weight:bold;letter-spacing:3px">GATHER</div><h1 style="font-size:26px">${escapeHtml(title)}</h1><p>Hello ${escapeHtml(data.guestName)},</p><p><strong>${escapeHtml(data.eventName)}</strong></p><p>${escapeHtml(response)}</p>${details ? `<p>${details}</p>` : ''}${link ? `<p><a style="display:inline-block;background:#292d28;color:white;padding:12px 18px;border-radius:8px;text-decoration:none" href="${escapeHtml(link)}">${linkLabel}</a></p>` : ''}<p style="color:#73766f">With joy in our hearts,<br>Gather</p></td></tr></table></td></tr></table></body></html>`;
  return { subject, html, text };
}
