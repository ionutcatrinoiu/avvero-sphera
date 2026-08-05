export default async function handler(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).json({ error: 'Metodă indisponibilă.' });
  }

  const cui = String(request.query?.cui || '').replace(/\D/g, '');
  if (!/^\d{2,10}$/.test(cui)) {
    return response.status(400).json({ error: 'CUI invalid.' });
  }

  try {
    const dateParts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Bucharest',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date()).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    const today = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
    const upstream = await fetch('https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify([{ cui: Number(cui), data: today }])
    });

    if (upstream.status === 429) {
      return response.status(429).json({ error: 'Serviciul ANAF a primit prea multe solicitări.' });
    }
    if (!upstream.ok) {
      return response.status(502).json({ error: 'ANAF nu a returnat datele firmei.' });
    }

    const payload = await upstream.json();
    const record = Array.isArray(payload?.found) ? payload.found[0] : null;
    const company = record?.date_generale || {};
    const address = record?.adresa_sediu_social || {};
    if (!record || !company.denumire) {
      return response.status(404).json({ error: 'Nu am găsit o firmă pentru acest CUI.' });
    }

    response.setHeader('Cache-Control', 'private, no-store');
    return response.status(200).json({
      cui: String(company.cui || cui).replace(/\D/g, ''),
      name: String(company.denumire || '').trim(),
      city: String(address.sdenumire_Localitate || '').trim(),
      county: String(address.sdenumire_Judet || '').trim(),
      registrationNumber: String(company.nrRegCom || '').trim(),
      fiscalStatus: String(company.stare_inregistrare || '').trim()
    });
  } catch (error) {
    return response.status(502).json({ error: 'Conexiunea cu ANAF nu este disponibilă.' });
  }
}
