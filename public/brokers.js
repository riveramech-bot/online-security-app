// Data broker / people-search catalog for the removal tracker.
// Opt-out links and requirements come from the Big Ass Data Broker Opt-Out List
// (updated 2026-09-27) plus a real removal run on 2026-10-18. These sites change
// their pages often, so every entry also tells the user what to do if the form fails.
//
// search(p): optional function returning a link that shows the person's listing.
//   p = { first, last, city, st, stateName, phones: ['2677186843', ...] }
//   Only sites where this was confirmed to work have one; the rest just open the opt-out page.
(function () {
  'use strict';

  var STATE_NAMES = {
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
    CT: 'Connecticut', DE: 'Delaware', DC: 'District-of-Columbia', FL: 'Florida', GA: 'Georgia',
    HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
    KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts',
    MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
    NE: 'Nebraska', NV: 'Nevada', NH: 'New-Hampshire', NJ: 'New-Jersey', NM: 'New-Mexico',
    NY: 'New-York', NC: 'North-Carolina', ND: 'North-Dakota', OH: 'Ohio', OK: 'Oklahoma',
    OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode-Island', SC: 'South-Carolina', SD: 'South-Dakota',
    TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
    WV: 'West-Virginia', WI: 'Wisconsin', WY: 'Wyoming'
  };

  // What each requirement means for the person doing it. These are the steps the
  // app can never do for you: captchas, certifications, and email links.
  var NEED_LABELS = {
    captcha: 'Captcha',
    emailConfirm: 'Email link',
    certify: 'Certify it\'s you',
    secondForm: '2nd form',
    profileUrl: 'Profile URL',
    call: 'Phone call',
    birthdate: 'Birthdate',
    id: 'Asks for ID'
  };

  function dash(s) { return String(s || '').trim().replace(/\s+/g, '-'); }
  function dashedPhone(p) {
    var d = String(p).replace(/\D/g, '');
    return d.length === 10 ? d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6) : null;
  }

  var BROKERS = [
    {
      id: 'beenverified', name: 'BeenVerified', also: 'PeopleLooker, PeopleSmart',
      optOutUrl: 'https://www.beenverified.com/app/optout/search',
      needs: ['captcha', 'emailConfirm'],
      steps: [
        'Search your name and state, then press "Proceed to Opt Out" on your record.',
        'Enter the alias email, tick the captcha, press "Send Verification Email".',
        'Click the link in the email they send.'
      ],
      tip: 'Only one opt-out per email address. If the email never arrives, or the site says a request was already sent, email the privacy team instead (button below).',
      fallbackEmail: 'privacy@beenverified.com'
    },
    {
      id: 'spokeo', name: 'Spokeo',
      optOutUrl: 'https://www.spokeo.com/optout',
      search: function (p) {
        if (!p.first || !p.last || !p.city || !STATE_NAMES[p.st]) return null;
        return 'https://www.spokeo.com/' + dash(p.first) + '-' + dash(p.last) + '/' + STATE_NAMES[p.st] + '/' + dash(p.city);
      },
      needs: ['profileUrl', 'captcha', 'emailConfirm'],
      steps: [
        'Open your Spokeo profile and copy its web address.',
        'On the opt-out page, use the lower "opt out your information" form: paste the address and the alias email.',
        'Tick the captcha, submit, then click the confirmation link they email.'
      ],
      tip: 'Ignore every paid upsell. Spokeo can also feed FreePeopleDirectory, so check that one too.'
    },
    {
      id: 'fastpeoplesearch', name: 'FastPeopleSearch',
      optOutUrl: 'https://www.fastpeoplesearch.com/optout',
      needs: ['certify', 'captcha', 'emailConfirm', 'secondForm'],
      steps: [
        'Choose "The subject of this request", enter your name and the alias email.',
        'Tick the certification box, pass the captcha, submit.',
        'Click the emailed link. On the second form, pick your record and submit until you see the "received" page.'
      ],
      tip: 'They say removal takes up to 3 days. The emailed link expires after 24 hours.'
    },
    {
      id: 'truepeoplesearch', name: 'TruePeopleSearch',
      optOutUrl: 'https://www.truepeoplesearch.com/removal',
      needs: ['certify', 'captcha', 'emailConfirm', 'secondForm'],
      steps: [
        'Choose "The subject of the request", enter your name and the alias email.',
        'Tick the certification box, pass the captcha, press "Send Request".',
        'Click the emailed link within 24 hours. Fill in the second form and submit.'
      ],
      tip: 'The emailed link is only valid for 24 hours. If it expires, start again.'
    },
    {
      id: 'usphonebook', name: 'USPhoneBook',
      optOutUrl: 'https://www.usphonebook.com/removal',
      search: function (p) {
        var ph = (p.phones || []).map(dashedPhone).filter(Boolean)[0];
        return ph ? 'https://www.usphonebook.com/' + ph : null;
      },
      needs: ['certify', 'captcha', 'emailConfirm', 'secondForm'],
      steps: [
        'Look up your phone number to see the listing.',
        'On the removal form, enter your name and the alias email, tick the certification and the captcha.',
        'Click the emailed link and finish the second form.'
      ],
      tip: 'The older /opt-out/ address can hang. Use the /removal form. If both fail, email them.',
      fallbackEmail: 'support+optout@usphonebook.com'
    },
    {
      id: 'thatsthem', name: 'That\'s Them',
      optOutUrl: 'https://thatsthem.com/optout',
      search: function (p) {
        if (!p.first || !p.last || !p.city || !p.st) return null;
        return 'https://thatsthem.com/name/' + dash(p.first) + '-' + dash(p.last) + '/' + dash(p.city) + '-' + p.st;
      },
      needs: [],
      steps: [
        'Search first. If there are no results, mark it "Not listed" and stop.',
        'Only if you are listed: submit the opt-out form with the details the site already shows.'
      ],
      tip: 'The form asks for a street address. Never type one in unless the site already lists you. Skip the identity-protection upsell.'
    },
    {
      id: 'nuwber', name: 'Nuwber',
      optOutUrl: 'https://nuwber.com/removal/link',
      needs: ['profileUrl', 'emailConfirm'],
      steps: [
        'Search your name, use "filter by state", and copy your profile address.',
        'Paste it into the removal form with the alias email and confirm the email link.'
      ],
      tip: 'The site may refuse automated browsers. Do not buy a report. If the form rejects the address, email a screenshot of your listing.',
      fallbackEmail: 'support@nuwber.com'
    },
    {
      id: 'clustrmaps', name: 'ClustrMaps',
      optOutUrl: 'https://clustrmaps.com/bl/opt-out',
      needs: ['profileUrl'],
      steps: [
        'Find your listing and copy its address.',
        'Submit it on the opt-out page. Mention every phone number the listing shows.'
      ],
      tip: 'Remove each separate listing. Old phone numbers often sit on their own pages.'
    },
    {
      id: 'whitepages', name: 'Whitepages', also: '411.com',
      optOutUrl: 'https://www.whitepages.com/suppression_requests',
      needs: ['call', 'profileUrl'],
      steps: [
        'Find your listing and copy its address.',
        'Submit the suppression request and enter a phone number.',
        'Answer the automated call and type the 4-digit code.'
      ],
      tip: 'Check Whitepages Premium and 411.com separately. They can still show you after the main site is clean.'
    },
    {
      id: 'intelius', name: 'Intelius family', also: 'Instant Checkmate, TruthFinder, US Search, Zabasearch, AnyWho and more',
      optOutUrl: 'https://suppression.peopleconnect.us/login',
      needs: ['emailConfirm'],
      steps: [
        'Use the suppression portal to request removal across all the PeopleConnect brands.',
        'Confirm by email. They may ask for old addresses or phone numbers to find you; only give details they already show.'
      ],
      tip: 'One request covers the whole family of sites. Phone fallback: 1-888-245-1655.',
      fallbackEmail: 'support@mailer.intelius.com'
    },
    {
      id: 'smartbackgroundchecks', name: 'SmartBackgroundChecks', also: 'likely also clears PeopleFinders',
      optOutUrl: 'https://www.smartbackgroundchecks.com/optout',
      needs: ['profileUrl'],
      steps: ['Find your record, copy its address, and submit it on the opt-out page.'],
      tip: ''
    },
    {
      id: 'checkpeople', name: 'CheckPeople',
      optOutUrl: 'https://checkpeople.com/opt-out',
      needs: ['birthdate'],
      steps: [
        'First file a "Right to Know" request at their privacy rights page.',
        'If they have your record, submit the opt-out with your full legal name and birthdate.'
      ],
      tip: 'The birthdate has to be entered by the person themselves. The app never stores it.'
    },
    {
      id: 'infotracer', name: 'InfoTracer',
      optOutUrl: 'https://infotracer.com/optout/',
      needs: ['profileUrl'],
      steps: ['Find your record and submit the online form. A mail-in form and a fax option exist if the web form fails.'],
      tip: ''
    },
    {
      id: 'mylife', name: 'MyLife',
      optOutUrl: 'https://www.mylife.com/privacyrequest',
      needs: ['id', 'call'],
      steps: [
        'Submit the privacy request with your name and profile link only.',
        'They may push you to upload a driver\'s license or phone them. Do not upload ID.'
      ],
      tip: 'Known to be slow and pushy. Email privacy@mylife.com with your name and profile link if the form stalls.',
      fallbackEmail: 'privacy@mylife.com'
    },
    {
      id: 'cyberbackgroundchecks', name: 'Cyber Background Checks',
      optOutUrl: 'https://www.cyberbackgroundchecks.com/removal',
      needs: ['profileUrl'], steps: ['Find your record and submit it on the removal page.'], tip: ''
    },
    {
      id: 'peoplesearchnow', name: 'PeopleSearchNow',
      optOutUrl: 'https://www.peoplesearchnow.com/opt-out',
      needs: [], steps: ['Find your record and submit it on the opt-out page.'], tip: ''
    },
    {
      id: 'searchpeoplefree', name: 'SearchPeopleFree',
      optOutUrl: 'https://www.searchpeoplefree.com/opt-out',
      needs: ['profileUrl'],
      steps: ['Search by name, phone number, address and email, since each can show a separate listing, then opt out.'],
      tip: ''
    },
    {
      id: 'usapeoplesearch', name: 'USA People Search',
      optOutUrl: 'https://www.usa-people-search.com/removal',
      needs: [], steps: ['Find your record and submit it on the removal page.'], tip: ''
    },
    {
      id: 'veripages', name: 'Veripages',
      optOutUrl: 'https://veripages.com/inner/control-privacy',
      needs: ['profileUrl', 'captcha', 'emailConfirm'],
      steps: ['Enter your profile address, name and the alias email, pass the captcha, then click the emailed link.'],
      tip: ''
    },
    {
      id: 'socialcatfish', name: 'Social Catfish',
      optOutUrl: 'https://socialcatfish.com/opt-out/',
      needs: ['profileUrl', 'emailConfirm'],
      steps: ['Copy the address of each page that shows your info and submit them with the alias email. Click the emailed confirmation.'],
      tip: 'Only ask for removal of items you can actually see on the site.'
    },
    {
      id: 'unmask', name: 'UnMask',
      optOutUrl: 'https://unmask.com/opt-out/',
      needs: ['captcha', 'emailConfirm'],
      steps: ['Enter your name, city and state, solve the captchas, then click the confirmation email.'],
      tip: ''
    },
    {
      id: 'searchquarry', name: 'SearchQuarry',
      optOutUrl: 'https://members.searchquarry.com/removeMyData/',
      needs: ['emailConfirm'],
      steps: ['Find your listing, submit it, then click the verification link in your inbox.'],
      tip: ''
    },
    {
      id: 'familytreenow', name: 'FamilyTreeNow',
      optOutUrl: 'https://www.familytreenow.com/optout',
      needs: [], steps: ['Search for yourself on the opt-out page and remove each record.'], tip: ''
    }
  ];

  window.FED_BROKERS = BROKERS;
  window.FED_NEED_LABELS = NEED_LABELS;
  window.FED_STATE_NAMES = STATE_NAMES;
})();
