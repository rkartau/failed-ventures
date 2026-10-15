// Content for the six per-country registry pages (SEO implementation plan WP-E, E2):
// /registries/{estonia,denmark,cyprus,united-kingdom,norway,france}. Rendered by
// components/RegistryCountryPage.tsx; each page file is a thin wrapper.
//
// CONTENT-ACCURACY RULE (plan R7, enforced by tests/seo-new-pages-e.test.mjs):
//   Prose may state ONLY (a) the public row fields `authority`, `authorityShort`,
//   `portalUrl`, `inputs[].label`, `userNotes` (via lib/registry/public-rows.ts), and
//   (b) facts read on the official portal page itself on 6 September 2026, cited with an
//   adjacent `[src:portal-<CODE>:...]` comment. Product facts about Docka cite
//   `[src:real-features]` or `[src:lib-registry-countries]`. Source ids are allowlisted in
//   repo docs/seo-new-pages-claims-sources.md ("## Registry pages"). The `notes` field of
//   countries.ts was never read for this file; the notes-shingle test proves it.
//
// STYLE: docs/WRITING-STYLE-GUIDE.md. Every string here also passes through
// `plainPunct()` at export (data layer, never JSX) so visible text and FAQPage JSON-LD
// `acceptedAnswer.text` are byte-identical (plan S1).

import { plainPunct } from "@/lib/seo";
import { REGISTRY_PAGE_SLUGS } from "@/lib/registry/public-rows";
import type { CountryCode } from "@/lib/registry/types";

export type RegistryPageFaq = { q: string; a: string };
export type RegistryPageSection = { h2: string; paras: string[] };

export type RegistryPageData = {
  /** Table code in countries.ts; the slug comes from REGISTRY_PAGE_SLUGS (one map). */
  code: CountryCode;
  slug: string;
  /** Plain country name used in the H1, breadcrumb and link text. */
  country: string;
  /** <title>, <= 52 chars so it stays <= 60 with the root template's " · Docka" suffix. */
  title: string;
  /** <meta description>, <= 160 chars. */
  description: string;
  h1: string;
  ogAlt: string;
  /** Two-sentence answer to the query, then one orienting sentence. */
  intro: string[];
  whatDockaConfirms: string[];
  /** Exactly three steps on the official portal, using the row's input labels. */
  diySteps: string[];
  caveats: string[];
  sections: RegistryPageSection[];
  faq: RegistryPageFaq[];
  /** One-line hint rendered next to the portal link (language, form type). */
  localHint: string;
};

const RAW: Omit<RegistryPageData, "slug">[] = [
  // ===================================================================================
  // ESTONIA
  // ===================================================================================
  {
    code: "EE",
    country: "Estonia",
    title: "Verify an Estonian Seafarer Certificate Online",
    description:
      "Check an Estonian certificate of competency, endorsement or medical certificate against Transpordiamet's validity check with the verification code.",
    h1: "Verify an Estonian seafarer certificate",
    ogAlt:
      "An Estonian seafarer certificate beside the Transpordiamet validity check, showing the verification code being submitted.",
    // [src:portal-EE:landing page title "Seafarers Information System"; /documents/validity "Validity check"] [src:lib-registry-countries:EE authority, input label "Verification code", capability auto]
    intro: [
      "To verify an Estonian seafarer certificate, enter the verification code printed on the document into the validity check of the Seafarers Information System run by Transpordiamet (the Estonian Transport Administration). Docka runs that same check for you, live and automatically, and labels the answer on its trust ladder.",
      // [src:portal-EE:validity check page]
      "This page explains what the Estonian portal asks for, what it returns, and where Docka's automatic check stops.",
    ],
    whatDockaConfirms: [
      // [src:portal-EE:validity check covers "certificate of competency, endorsement or medical certificate"] [src:lib-registry-countries:EE portalUrl]
      "The check goes to Transpordiamet's own Seafarers Information System at meremees.transpordiamet.ee, the flag-state source for Estonian certificates of competency (CoC), endorsements and seafarer medical certificates.",
      // [src:lib-registry-countries:EE has one input, label "Verification code"]
      "Docka needs one input: the Verification code printed on the document. No name, no personal identification code and no date of birth is sent.",
      // [src:lib-registry-countries:EE capability auto] [src:real-features:timestamped result]
      "The check is live and automatic. Docka reports the status the portal returns and stamps the result with the time of the query.",
      // [src:real-features:not-found is reported as not found, never rounded up or down]
      "A code the portal does not recognise comes back as not found. Docka shows that as it is; it does not guess.",
    ],
    diySteps: [
      // [src:portal-EE:landing page without JavaScript shows "Seafarers Information System can not be displayed, because JavaScript is disabled"; link "Validity check"]
      "Open the official portal at meremees.transpordiamet.ee and choose Validity check. The portal needs JavaScript; with scripts blocked it shows a blank page with a notice.",
      // [src:portal-EE:"Enter the verification code of a certificate of competency, endorsement or medical certificate or scan the QR-code on the document."] [src:lib-registry-countries:input label "Verification code"]
      "Pick the Document verification code query and type the Verification code exactly as printed on the certificate, endorsement or medical certificate. You can also scan the QR code on the document.",
      // [src:portal-EE:"the response to query will display the status and content of the seafarer's endorsement or certificate of competency, or the status and start and end date of his/her medical certificate"; button "Submit query"]
      "Press Submit query. For a certificate of competency or an endorsement the portal shows the status and content of the document. For a medical certificate it shows the status with the start and end date.",
    ],
    caveats: [
      // [src:lib-registry-countries:EE has no userNotes] [src:portal-EE:no coverage statement on the validity page]
      "Transpordiamet publishes no coverage caveat on the validity page, and Docka has none to add. We do not know of a cut-off year for older documents.",
      // [src:portal-EE:three query modes listed: "Document verification code", "Seafarer's personal identification code and document number", "Seafarer name and birthday"] [src:lib-registry-countries:Docka's EE input is the verification code only]
      "The portal offers two other query modes: by personal identification code plus document number, and by name plus birthday. Docka does not use them. If the verification code is unreadable, the fallback is a query by a person on the portal, not an automatic one in Docka.",
    ],
    sections: [
      {
        h2: "Which Estonian documents the validity check covers",
        paras: [
          // [src:portal-EE:"A query can be submitted to check the validity of a certificate of competency, endorsement or medical certificate."]
          "The validity check answers for three document families: certificates of competency, endorsements, and seafarer medical certificates. The wording is the portal's own.",
          // [src:portal-EE:"Seafarers Information System enables seafarers to apply for certificates and endorsements"; "Log in" button]
          "The same system is where Estonian seafarers apply for certificates and endorsements after logging in. The validity check is the public part; no account is needed.",
          // [src:portal-EE:landing notice "To revalidate an endorsement for GOC/ROC seafarers are required to complete refresher training covering the new GMDSS regulations in accordance with SOLAS Chapter IV (revised with IMO resolution MSC.496(105))."]
          "The landing page carried a notice on 6 September 2026 about GMDSS operators: to revalidate a GOC or ROC endorsement, seafarers must complete refresher training on the revised SOLAS Chapter IV rules (IMO resolution MSC.496(105)). If you are checking a radio operator's endorsement, expect that revalidation history to matter.",
        ],
      },
      {
        h2: "Reading the result",
        paras: [
          // [src:portal-EE:"display the status and content of the seafarer's endorsement or certificate of competency"]
          "A certificate of competency or endorsement result contains the status and the content of the document, so you can compare the capacity and the limitations against what the seafarer showed you.",
          // [src:portal-EE:"the status and start and end date of his/her medical certificate"]
          "A medical certificate result is thinner: status plus a start and an end date. It does not restate the medical findings.",
          // [src:portal-EE:footer "E-mail: info@transpordiamet.ee Phone: 620 1200 Valge 4, 11413 Tallinn, Estonia"]
          "Transpordiamet lists its contact details on the portal: info@transpordiamet.ee, telephone 620 1200 and Valge 4, 11413 Tallinn. Use them when the portal answer and the paper disagree.",
        ],
      },
    ],
    faq: [
      {
        q: "Do I need the seafarer's personal identification code to check an Estonian certificate?",
        // [src:portal-EE:three query modes] [src:lib-registry-countries:Docka uses the verification code only]
        a: "Not for the verification-code query. The portal has a second mode that asks for the personal identification code and the document number, and a third that asks for name and birthday, but the code printed on the document is enough on its own. Docka uses only the code.",
      },
      {
        q: "Can I check an Estonian seafarer medical certificate?",
        // [src:portal-EE:medical certificate result shows "status and start and end date"]
        a: "Yes. The validity check covers medical certificates. The answer shows the status and the period of validity (start and end date), nothing more.",
      },
      {
        q: "What language is the Estonian portal in?",
        // [src:portal-EE:"EST" language switch; English texts on the page]
        a: "Estonian and English. The switch is in the top corner (EST). The English wording quoted on this page is the portal's own.",
      },
      {
        q: "Is Docka connected to Transpordiamet?",
        // [src:real-features:Docka queries the public official service; independent company]
        a: "Docka sends the verification code to the same public validity check any inspector can open, and returns what it says. Docka is not part of Transpordiamet and has no special access.",
      },
      {
        q: "Why does the Estonian portal show a blank page?",
        // [src:portal-EE:no-JavaScript notice "Seafarers Information System can not be displayed, because JavaScript is disabled in Your browser."]
        a: "It needs JavaScript. The page you get with scripts disabled says only that the Seafarers Information System cannot be displayed. Enable scripts and reload.",
      },
    ],
    // [src:portal-EE:EST/English switch; JavaScript app]
    localHint: "Estonian and English. Needs JavaScript.",
  },

  // ===================================================================================
  // DENMARK
  // ===================================================================================
  {
    code: "DK",
    country: "Denmark",
    title: "Verify a Danish Seafarer Certificate (DMA)",
    description:
      "Check a Danish STCW certificate against the Danish Maritime Authority's online verification service with the certificate number. Live and automatic in Docka.",
    h1: "Verify a Danish seafarer certificate",
    ogAlt:
      "A Danish STCW certificate beside the Danish Maritime Authority's online verification service, showing the certificate number field.",
    intro: [
      // [src:portal-DK:"Online Verification Service", branch "STCW certificate", field "Certificate number"] [src:lib-registry-countries:DK authority, portalUrl verify.dma.dk, input "Certificate number"]
      "To verify a Danish seafarer certificate, type the certificate number into the STCW certificate service at verify.dma.dk, the online verification service of Søfartsstyrelsen (the Danish Maritime Authority). Docka submits that number for you and returns the portal's answer, live.",
      // [src:lib-registry-countries:DK has a single input; no date of birth, no seafarer ID]
      "The Danish check is one of the simplest Docka runs: one number, no date of birth, no seafarer ID.",
    ],
    whatDockaConfirms: [
      // [src:portal-DK:"prove validity of STCW certificates issued by the Danish Maritime Authority"] [src:lib-registry-countries:DK portalUrl]
      "The check goes to Søfartsstyrelsen's own service at verify.dma.dk, the flag-state source for STCW certificates issued by the Danish Maritime Authority.",
      // [src:lib-registry-countries:DK input label "Certificate number"]
      "One input: the Certificate number as printed. Nothing about the holder is sent.",
      // [src:lib-registry-countries:DK capability auto] [src:real-features:timestamped result]
      "The check is live and automatic. Docka records the answer with a timestamp so a port state control (PSC) inspector sees when the register was asked.",
      // [src:portal-DK:"The verification produces a result on validity and basic information from the certificate"]
      "Docka reports the validity answer the service returns.",
    ],
    diySteps: [
      // [src:portal-DK:landing page buttons "STCW certificate", "Ship certificate", "Medical certificate"]
      "Open verify.dma.dk. The landing page offers three services: STCW certificate, Ship certificate and Medical certificate. Choose STCW certificate.",
      // [src:portal-DK:"Enter the certificate number below and press verify."] [src:lib-registry-countries:input label "Certificate number"]
      "Enter the Certificate number in the single box and press Verify.",
      // [src:portal-DK:"The verification produces a result on validity and basic information from the certificate, furthermore a copy of the certificate can be opened for view of all details."]
      "Read the result. The service states whether the certificate is valid and shows basic information from it. A copy of the certificate can be opened from the result to compare every detail with the paper in front of you.",
    ],
    caveats: [
      // [src:lib-registry-countries:DK has no userNotes] [src:portal-DK:no cut-off statement on the STCW page]
      "The Danish Maritime Authority publishes no cut-off year on the service, and Docka has no coverage caveat to add for Denmark.",
      // [src:portal-DK:"DA" language switch top right; English default]
      "The service is in English with a DA switch for Danish, top right. The English wording quoted on this page is the portal's own.",
      // [src:real-features:not-found is reported as not found, never as a fraud finding]
      "A number the service does not know returns no certificate. Docka passes that on as not found. It is not a fraud finding on its own; a typo in one digit produces the same answer.",
    ],
    sections: [
      {
        h2: "What the portal says about itself",
        paras: [
          // [src:portal-DK:"The STCW Convention requires that certificates and endorsements can be verified at the issuing administration. This online service offers verification, in order to prove validity of STCW certificates issued by the Danish Maritime Authority."]
          "The STCW certificate page opens with the reason the service exists: the STCW Convention requires that certificates and endorsements can be verified at the issuing administration. The Danish Maritime Authority built this service to prove the validity of the STCW certificates it issues.",
          // [src:real-features:PSV definition, register is the original record]
          "That sentence is the whole argument for primary source verification. The issuing administration holds the record. A PDF, a stamp or a laminated card is a copy of it.",
        ],
      },
      {
        h2: "Certificate copy versus validity answer",
        paras: [
          // [src:portal-DK:"a result on validity and basic information from the certificate, furthermore a copy of the certificate can be opened"]
          "The Danish result has two layers. The first is the validity statement with basic certificate data. The second is a viewable copy of the certificate itself.",
          // [src:portal-DK:copy of the certificate can be opened for view of all details]
          "For a crewing manager the first layer is usually enough. For a PSC inspector who suspects an altered document, the second layer settles it: compare the copy the register holds with the copy the seafarer carries.",
          // [src:lib-registry-countries:DK input is the certificate number]
          "Docka's automatic check works from the validity layer. If you need the register's copy, open the portal yourself with the same number.",
        ],
      },
      {
        h2: "Ship and medical certificates on the same portal",
        paras: [
          // [src:portal-DK:branches "Ship certificate", "Medical certificate"] [src:lib-registry-countries:DK connector is the STCW certificate check]
          "verify.dma.dk also verifies ship certificates and seafarer medical certificates. Docka's Denmark connector covers the STCW branch. For the other two, use the portal directly.",
          // [src:lib-registry-countries:DK connector input is the STCW certificate number]
          "If a candidate shows a Danish medical certificate, open that branch on the portal and check it there. Docka's automatic result for Denmark speaks only to the STCW certificate number you entered.",
        ],
      },
    ],
    faq: [
      {
        q: "Does the Danish check need the seafarer's date of birth?",
        // [src:lib-registry-countries:DK input is the certificate number only; NO and UK inputs include "Date of birth"]
        a: "No. The STCW certificate service asks for the certificate number only. Norway and the United Kingdom ask for a date of birth; Denmark does not.",
      },
      {
        q: "Can I see the actual certificate on verify.dma.dk?",
        // [src:portal-DK:"a copy of the certificate can be opened for view of all details"]
        a: "Yes. After a successful lookup the service lets you open a copy of the certificate to view all details.",
      },
      {
        q: "Does verify.dma.dk cover Danish medical certificates?",
        // [src:portal-DK:"Medical certificate" branch on the landing page]
        a: "Yes, under its own Medical certificate branch on the landing page. That branch is separate from the STCW check Docka runs.",
      },
      {
        q: "Is the Danish service in English?",
        // [src:portal-DK:English default, "DA" switch]
        a: "Yes. The site loads in English with a DA switch for Danish.",
      },
      {
        q: "Why did Docka return not found for a Danish certificate?",
        // [src:real-features:not-found reporting] [src:lib-registry-countries:DK authority]
        a: "The number was not recognised by the service. Check the digits against the document and retry on the portal. Only Søfartsstyrelsen can say why a genuine certificate is missing from its register.",
      },
    ],
    // [src:portal-DK:English with DA switch]
    localHint: "English, with a Danish (DA) switch.",
  },

  // ===================================================================================
  // CYPRUS
  // ===================================================================================
  {
    code: "CY",
    country: "Cyprus",
    title: "Verify a Cyprus Seafarer Certificate (DMS)",
    description:
      "Check a Cyprus seafarer certificate against the Shipping Deputy Ministry's authentication form using the Seafarer ID and certificate number. Live in Docka.",
    h1: "Verify a Cypriot seafarer certificate",
    ogAlt:
      "A Cyprus seafarer certificate beside the Shipping Deputy Ministry's Authentication of Seafarer Certificate form with its two fields.",
    intro: [
      // [src:portal-CY:heading "SHIPPING DEPUTY MINISTRY: Authentication of Seafarer Certificate"; fields "Seafarer ID No" and "Certificate No"] [src:lib-registry-countries:CY authority, inputs "Seafarer ID", "Certificate number"]
      "To verify a Cyprus seafarer certificate, enter the Seafarer ID and the Certificate number into the Authentication of Seafarer Certificate form run by the Shipping Deputy Ministry, Department of Merchant Shipping. Docka submits both values and returns the ministry's answer.",
      // [src:lib-registry-countries:CY is the only auto entry with a seafarer-ID input]
      "Cyprus is the one flag state on this site whose portal asks for the seafarer's own ID number as well as the certificate number, so the check is a pairing test: this certificate, this person.",
    ],
    whatDockaConfirms: [
      // [src:lib-registry-countries:CY portalUrl eservices.dms.gov.cy]
      "The check goes to the Shipping Deputy Ministry's own form on eservices.dms.gov.cy, the flag-state source for Cyprus STCW certificates.",
      // [src:portal-CY:both fields required, "*Mandatory Fields"] [src:lib-registry-countries:two inputs]
      "Two inputs: Seafarer ID and Certificate number. Both are mandatory on the official form and both are required in Docka.",
      // [src:lib-registry-countries:CY capability auto] [src:real-features:timestamped result]
      "The check is live and automatic. Docka returns what the form returns and time-stamps it.",
      // [src:portal-CY:the form pairs Seafarer ID No with Certificate No]
      "Because the form pairs the holder's ID with the certificate, a match confirms the certificate number is on record for that seafarer ID.",
    ],
    diySteps: [
      // [src:portal-CY:page title "SHIPPING DEPUTY MINISTRY: Authentication of Seafarer Certificate"]
      "Open the official form at eservices.dms.gov.cy (the page title reads SHIPPING DEPUTY MINISTRY: Authentication of Seafarer Certificate).",
      // [src:portal-CY:"Note: Seafarer ID No. is shown on the top left hand corner of the Certificate."; fields "Seafarer ID No", "Certificate No"] [src:lib-registry-countries:input labels]
      "Type the Seafarer ID into Seafarer ID No. The portal's own note says the Seafarer ID No. is shown on the top left hand corner of the certificate. Then type the Certificate number into Certificate No.",
      // [src:portal-CY:buttons "Search" and "Reset"]
      "Press Search. Reset clears both boxes.",
    ],
    caveats: [
      // [src:lib-registry-countries:CY has no userNotes] [src:portal-CY:no coverage statement on the form]
      "The ministry publishes no coverage caveat on the form itself. We have no statement from the authority about how far back the online record reaches, so treat an unrecognised older certificate as unresolved and ask the ministry.",
      // [src:portal-CY:"*Mandatory Fields" on both inputs]
      "Both fields are marked mandatory. A lookup with the certificate number alone is not possible on this portal, in Docka or by hand.",
      // [src:portal-CY:plain HTML form; the page rendered fully in a scriptless fetch]
      "The form is plain HTML and works without JavaScript, which makes it one of the easier portals to open on a slow connection at sea.",
    ],
    sections: [
      {
        h2: "Why the Seafarer ID matters",
        paras: [
          // [src:lib-registry-countries:other auto entries key on certificate number and sometimes date of birth; CY keys on Seafarer ID]
          "Most flag-state checkers key on the certificate number and, sometimes, a date of birth. Cyprus keys on the seafarer's own registration number with the Department of Merchant Shipping.",
          // [src:portal-CY:Seafarer ID No. is on the top left hand corner of the certificate]
          "The practical effect: you cannot authenticate a Cyprus certificate from a photocopy that cuts off the top left corner. Ask for the full first page.",
          // [src:portal-CY:the form tests the ID + certificate pairing] [src:real-features:recycled certificate = a real number on another person's document]
          "For an agency this is useful. A recycled certificate (a real number placed on another person's document) is exactly what a pairing test is built to catch, because the ID on the page and the number must belong together in the ministry's record.",
        ],
      },
      {
        h2: "What the form does and does not tell you",
        paras: [
          // [src:portal-CY:title "Authentication of Seafarer Certificate"]
          "The form's title is Authentication of Seafarer Certificate. It confirms the pairing of ID and certificate number against the ministry's record.",
          // [src:portal-CY:two inputs and a Search button; no listing or document copy on the form] [src:portal-DK:Danish service opens a copy of the certificate]
          "It does not let you browse a seafarer's other certificates, and it does not show a copy of the document the way the Danish service does. Read the answer for the certificate you asked about, then ask about the next one separately.",
        ],
      },
    ],
    faq: [
      {
        q: "Where is the Seafarer ID on a Cyprus certificate?",
        // [src:portal-CY:"Seafarer ID No. is shown on the top left hand corner of the Certificate."]
        a: "Top left hand corner of the certificate, according to the note on the ministry's own form.",
      },
      {
        q: "Can I check a Cyprus certificate with the certificate number only?",
        // [src:portal-CY:both fields mandatory]
        a: "No. The form marks both Seafarer ID No. and Certificate No. as mandatory.",
      },
      {
        q: "Which authority issues Cyprus seafarer certificates?",
        // [src:lib-registry-countries:CY authority "Shipping Deputy Ministry, Department of Merchant Shipping (Cyprus)"; portal domain eservices.dms.gov.cy]
        a: "The Shipping Deputy Ministry, through its Department of Merchant Shipping. The check form sits on the ministry's eservices.dms.gov.cy domain.",
      },
      {
        q: "Does the Cyprus form work without JavaScript?",
        // [src:portal-CY:plain HTML form with two text inputs and Search/Reset buttons]
        a: "Yes. It is a plain form with two text boxes, a Search button and a Reset button.",
      },
      {
        q: "Is Docka's Cyprus answer a government verification?",
        // [src:lib-registry-countries:CY capability auto, flag-state authority] [src:real-features:L3 Government-verified reserved for the issuing government's registry; not-found is never shown as invalid]
        a: "It comes from the flag-state ministry's own form, so a confirmed pairing is labelled at the top of Docka's trust ladder. An unrecognised pair is labelled as not found, never as invalid.",
      },
    ],
    // [src:portal-CY:English plain HTML form]
    localHint: "English. Plain form, no JavaScript needed.",
  },

  // ===================================================================================
  // UNITED KINGDOM
  // ===================================================================================
  {
    code: "UK",
    country: "United Kingdom",
    title: "Verify a UK Seafarer Certificate (MCA)",
    description:
      "Check a UK CoC, CoP, FSE or GMDSS certificate against the MCA's online checker with the Document ID and date of birth. Docka runs the lookup live.",
    h1: "Verify a UK seafarer certificate",
    ogAlt:
      "A UK certificate of competency beside the Maritime and Coastguard Agency's Online UK CoC/FSE checker on GOV.UK.",
    intro: [
      // [src:portal-UK:title "Online UK CoC/FSE checker"; service header "Maritime and Coastguard Agency document verification service"; fields "Document ID", "Seafarer's date of birth"] [src:lib-registry-countries:UK authority, portalUrl coccec.mcga.gov.uk, inputs "Document ID", "Date of birth"]
      "To verify a UK seafarer certificate, enter the Document ID and the seafarer's date of birth into the Online UK CoC/FSE checker at coccec.mcga.gov.uk, the document verification service of the Maritime and Coastguard Agency (MCA). Docka runs that lookup for you and returns the MCA's answer.",
      // [src:portal-UK:Document Type drop-down lists 14 options from "Able Seafarer" to "Ships Cook Certificate of Competency"]
      "The checker covers far more than certificates of competency. Fourteen document types are on its list, from Able Seafarer to the Ships Cook Certificate of Competency.",
    ],
    whatDockaConfirms: [
      // [src:portal-UK:GOV.UK header; "verify a MCA issued certificate, document or license"] [src:lib-registry-countries:UK portalUrl]
      "The check goes to the MCA's own GOV.UK service, the flag-state source for MCA-issued seafarer documents.",
      // [src:portal-UK:privacy notice "The MCA will use the date of birth and certificate number to confirm the validity of UK issued seafarer certification"; "The information is not retained once the validity check has been completed"] [src:lib-registry-countries:inputs "Document ID", "Date of birth"]
      "Two inputs: Document ID and Date of birth. The MCA's privacy notice on the checker says it uses the date of birth and certificate number to confirm validity and does not retain them once the check is complete.",
      // [src:lib-registry-countries:UK capability auto] [src:real-features:timestamped result]
      "Live and automatic. The result is time-stamped in Docka.",
      // [src:portal-UK:form has a "Document Type" select] [src:lib-registry-countries:Docka's UK inputs are Document ID and Date of birth only]
      "The official form also asks for a document type. Docka asks you for the Document ID and the date of birth only.",
    ],
    diySteps: [
      // [src:portal-UK:service header; "Use this service to verify a MCA issued certificate, document or license of a UK registered Seafarer or Boatmaster, including FSE's."]
      "Open coccec.mcga.gov.uk. The service header reads Maritime and Coastguard Agency document verification service, and the page says it verifies an MCA-issued certificate, document or licence of a UK registered seafarer or boatmaster, including flag state endorsements (FSEs).",
      // [src:portal-UK:Document Type options include CoC, COP, FSE, GOC, LRC, ROC, BML; field "Document ID"] [src:lib-registry-countries:input label "Document ID"]
      "Select the Document Type from the drop-down (CoC, COP, FSE, GOC, LRC, ROC, BML and the others), then type the Document ID.",
      // [src:portal-UK:"Seafarer's date of birth" with Day / Month / Year boxes; "Check" button] [src:lib-registry-countries:input label "Date of birth"]
      "Enter the seafarer's date of birth as day, month and year and press Check.",
    ],
    caveats: [
      // [src:lib-registry-countries:UK has no userNotes] [src:portal-UK:no coverage statement on the checker]
      "The MCA gives no coverage cut-off on the checker page, and Docka has none to add.",
      // [src:portal-UK:"The MCA will use the date of birth and certificate number to confirm the validity"]
      "The MCA states it uses the date of birth together with the certificate number to confirm validity. Take the date from the passport or discharge book, not from memory.",
      // [src:portal-UK:"FSE (Flag State Endorsement)" and "FSE Fishing" are separate document types]
      "A flag state endorsement (FSE) is its own document type on the checker. Checking it confirms the UK endorsement, not the foreign certificate it recognises. Check that certificate with its own flag state.",
    ],
    sections: [
      {
        h2: "The fourteen document types on the checker",
        paras: [
          // [src:portal-UK:Document Type select options, verbatim order]
          "The drop-down on the MCA form lists: Able Seafarer; ATO (Authority to Operate); CoC (Certificate of Competency); COP (Certificate of Proficiency); FSE (Flag State Endorsement); FSE Fishing; General Operator's Certificate; GOC Endorsement; LRC (Long Range Certificate); Rating; Restricted Operator's Certificate; ROC Endorsement; BML (Boat Master's Licence); Ships Cook Certificate of Competency.",
          // [src:portal-UK:same form covers CoC, GOC/ROC/LRC radio certificates and BML]
          "So the same form authenticates a master's CoC, a GMDSS radio operator's certificate and a boatmaster's licence. Pick the type that matches the heading on the document.",
        ],
      },
      {
        h2: "Privacy on the MCA checker",
        paras: [
          // [src:portal-UK:privacy notice: data controller is the MCA; "as part of our public task"; "not retained once the validity check has been completed and is not shared outside of the MCA"]
          "The checker carries its own privacy notice. The data controller is the MCA. The date of birth and certificate number are used to confirm validity as part of the MCA's public task, the information is not retained once the check is completed, and it is not shared outside the MCA.",
          // [src:portal-UK:footer "All content is available under the Open Government Licence v3.0, except where otherwise stated"]
          "Content on the service is published under the Open Government Licence v3.0 except where otherwise stated.",
        ],
      },
      {
        h2: "Boatmasters and fishing endorsements",
        paras: [
          // [src:portal-UK:options "BML (Boat Master's Licence)" and "FSE Fishing"]
          "Two entries on the list are easy to miss: BML (Boat Master's Licence) and FSE Fishing. If a candidate presents either, the same checker answers.",
          // [src:portal-UK:one form, one "Document ID" field, one date-of-birth fieldset and one "Check" button for every document type]
          "Both sit in the same drop-down as the CoC, so the lookup takes the same Document ID, the same date of birth and the same Check button.",
        ],
      },
    ],
    faq: [
      {
        q: "Is the UK checker only for certificates of competency?",
        // [src:portal-UK:Document Type options]
        a: "No. Its name says CoC/FSE, but the document type list also covers certificates of proficiency, GMDSS operator certificates (GOC, ROC, LRC) and their endorsements, ratings, Able Seafarer certificates, boatmaster's licences and the Ships Cook CoC.",
      },
      {
        q: "Does the MCA keep the date of birth I enter?",
        // [src:portal-UK:privacy notice "not retained once the validity check has been completed and is not shared outside of the MCA"]
        a: "The checker's privacy notice says the information is not retained once the validity check has been completed and is not shared outside the MCA.",
      },
      {
        q: "What is an FSE on the MCA checker?",
        // [src:portal-UK:"FSE (Flag State Endorsement)", "FSE Fishing"]
        a: "A Flag State Endorsement: the UK's recognition of a certificate issued by another country. On the checker it is a separate document type from CoC, with a further FSE Fishing variant.",
      },
      {
        q: "Can I check a boatmaster's licence on the same service?",
        // [src:portal-UK:"BML (Boat Master's Licence)" option]
        a: "Yes. BML (Boat Master's Licence) is one of the document types in the drop-down.",
      },
      {
        q: "Does Docka send the seafarer's date of birth to the MCA?",
        // [src:lib-registry-countries:UK inputs "Document ID", "Date of birth"] [src:portal-UK:date of birth is a required field]
        a: "Yes, because the MCA form requires it. Docka asks you for the Document ID and the Date of birth, the two inputs the MCA check needs.",
      },
    ],
    // [src:portal-UK:GOV.UK service in English]
    localHint: "English. GOV.UK service.",
  },

  // ===================================================================================
  // NORWAY
  // ===================================================================================
  {
    code: "NO",
    country: "Norway",
    title: "Verify a Norwegian Seafarer Certificate (NMA)",
    description:
      "Check a Norwegian seafarer certificate against Sjøfartsdirektoratet's verification service with the certificate number and date of birth. Live in Docka.",
    h1: "Verify a Norwegian seafarer certificate",
    ogAlt:
      "A Norwegian seafarer certificate beside the Sjøfartsdirektoratet verification service form with its date of birth and certificate number fields.",
    intro: [
      // [src:portal-NO:form "Søk etter sertifikat" with "Fødselsdato" and "Sertifikatnummer"] [src:lib-registry-countries:NO authority, portalUrl verify.certificate.sdir.no, inputs "Certificate number", "Date of birth"]
      "To verify a Norwegian seafarer certificate, enter the certificate number and the holder's date of birth into the verification service at verify.certificate.sdir.no, run by Sjøfartsdirektoratet (the Norwegian Maritime Authority). Docka submits both and returns the authority's answer.",
      // [src:portal-NO:three Norwegian labels, no English seen on the search page]
      "The Norwegian form is short and in Norwegian. This page translates its three labels and explains what Docka does with the answer.",
    ],
    whatDockaConfirms: [
      // [src:lib-registry-countries:NO portalUrl]
      "The check goes to Sjøfartsdirektoratet's own service at verify.certificate.sdir.no, the flag-state source for Norwegian certificates.",
      // [src:lib-registry-countries:NO inputs "Certificate number", "Date of birth"]
      "Two inputs: Certificate number and Date of birth.",
      // [src:lib-registry-countries:NO capability auto] [src:real-features:timestamped result]
      "Live and automatic, time-stamped in Docka.",
      // [src:portal-NO:form has two fields and a search button, no document-type selector]
      "The Norwegian form has no document-type selector. The number and the birth date are the whole query.",
    ],
    diySteps: [
      // [src:portal-NO:scriptless page shows "You need to enable JavaScript to run this app."]
      "Open verify.certificate.sdir.no. The page needs JavaScript; without it you see only a line asking you to enable it.",
      // [src:portal-NO:"Søk etter sertifikat", "Fødselsdato", "Sertifikatnummer"] [src:lib-registry-countries:input labels "Date of birth", "Certificate number"]
      "Under the heading Søk etter sertifikat (search for certificate), fill in Fødselsdato (Date of birth) and Sertifikatnummer (Certificate number).",
      // [src:portal-NO:button "Søk"]
      "Press Søk (search) and read the result.",
    ],
    caveats: [
      // [src:lib-registry-countries:NO has no userNotes] [src:portal-NO:no coverage statement on the form]
      "Sjøfartsdirektoratet publishes no coverage caveat on the form, and Docka adds none.",
      // [src:portal-NO:page opened 6 September 2026 showed Norwegian labels only]
      "The form we opened on 6 September 2026 showed Norwegian labels only, with no language switch on the search page. The three words above are all you need.",
      // [src:lib-registry-countries:NO and UK both take "Date of birth"]
      "As with the United Kingdom, the date of birth is part of the key. Take it from an identity document.",
      // [src:lib-registry-countries:NO authority Sjøfartsdirektoratet] [src:real-features:Docka reports the register's answer, it does not issue its own]
      "The answer comes from Sjøfartsdirektoratet, not from Docka. If the portal and the paper disagree, the register wins, and the question goes to the authority.",
    ],
    sections: [
      {
        h2: "Entering a Norwegian certificate number",
        paras: [
          // [src:portal-NO:field "Sertifikatnummer"] [src:lib-registry-countries:input label "Certificate number"]
          "The form asks for the certificate number as printed, and Docka's input label is the same: Certificate number. Copy it as printed, letters included.",
          // [src:portal-NO:field "Fødselsdato"]
          "The date of birth goes into Fødselsdato. If the seafarer's passport and seaman's book disagree on the date, try the passport first and note which one matched.",
          // [src:lib-registry-countries:NO inputs are the certificate number and the date of birth]
          "Have both values in front of you before you open the form. The certificate number is on the certificate. The date of birth is on the passport or the seaman's book. A candidate who can produce one but not the other has not given you enough to run the check, on the portal or in Docka.",
        ],
      },
      {
        h2: "Who uses this check",
        paras: [
          // [src:real-features:PSV: the register is the original record, the paper is the copy]
          "For a crewing manager the check answers the question a PDF cannot: is this number, for this person, on the Norwegian register today. For a seafarer it is a quick way to confirm a renewal went through before a joining date. For a PSC inspector it is the primary source; the paper is the copy.",
          // [src:portal-NO:public search page with two fields, no login]
          "Whoever asks, the answer comes from the same two fields. There is no separate inspector view and no login on the search page.",
          // [src:real-features:timestamped result and L0-L3 trust-ladder label]
          "Docka adds two things the portal does not: a timestamp for when the register was asked, and a trust-ladder label that says how far the check reached.",
        ],
      },
      {
        h2: "Norway in Docka's registry set",
        paras: [
          // [src:lib-registry-countries:capability auto entries EE, DK, CY, UK, NO, FR, UA-MARAD, AZ]
          "Norway is one of the flag states Docka checks live and automatically. Estonia, Denmark, Cyprus, the United Kingdom, France, Ukraine's state registry and Azerbaijan are the others; each has its own page under Registry coverage.",
          // [src:lib-registry-countries:UA-MARAD userNotes "reliably covers documents issued 2023 and later"; NO has no userNotes]
          "Ukraine's state registry carries a coverage note about documents issued before 2023. Norway has no equivalent note from its authority, so Docka shows none.",
        ],
      },
    ],
    faq: [
      {
        q: "What do the Norwegian labels on verify.certificate.sdir.no mean?",
        // [src:portal-NO:"Søk etter sertifikat", "Fødselsdato", "Sertifikatnummer", "Søk"]
        a: "Søk etter sertifikat is search for certificate. Fødselsdato is date of birth. Sertifikatnummer is certificate number. Søk is search.",
      },
      {
        q: "Do I need the seafarer's date of birth for the Norwegian check?",
        // [src:portal-NO:two fields on the form] [src:lib-registry-countries:input "Date of birth"]
        a: "Yes. The form has two fields and both are part of the lookup.",
      },
      {
        q: "Is the Norwegian verification page available in English?",
        // [src:portal-NO:Norwegian labels only on the search page, 6 September 2026]
        a: "The search page we opened on 6 September 2026 showed Norwegian only. The labels are few, and translated above.",
      },
      {
        q: "Which authority is behind verify.certificate.sdir.no?",
        // [src:lib-registry-countries:NO authority "Sjøfartsdirektoratet, Norwegian Maritime Authority"; hostname sdir.no]
        a: "Sjøfartsdirektoratet, the Norwegian Maritime Authority. The sdir.no domain is the authority's own.",
      },
      {
        q: "What if the Norwegian page stays blank?",
        // [src:portal-NO:"You need to enable JavaScript to run this app."]
        a: "Enable JavaScript. The service is a browser app and shows a one-line notice instead of the form when scripts are off.",
      },
    ],
    // [src:portal-NO:Norwegian labels; JavaScript app]
    localHint: "Norwegian labels (translated below). Needs JavaScript.",
  },

  // ===================================================================================
  // FRANCE
  // ===================================================================================
  {
    code: "FR",
    country: "France",
    title: "Verify a French Seafarer Certificate (PROMETE)",
    description:
      "Check a French STCW certificate or endorsement on PROMETE, the Direction des affaires maritimes database, with the numéro de titre and administration number.",
    h1: "Verify a French seafarer certificate",
    ogAlt:
      "A French STCW certificate beside the PROMETE search form of the Direction des affaires maritimes, showing the title number and holder number fields.",
    intro: [
      // [src:portal-FR:"Bienvenue sur PROMETE"; service "Authentifier un titre ou un visa"; form fields "N° du titre", "N° du titulaire"] [src:lib-registry-countries:FR authority, inputs "Numéro de titre", "Numéro d'administration", "Numéro de version (if present)"]
      "To verify a French seafarer certificate, use PROMETE, the online service of the Direction des affaires maritimes (Affaires maritimes, DAM), and enter the numéro de titre and the holder's administration number. Docka submits the same values, plus the version number when the document carries one, and returns PROMETE's answer.",
      // [src:portal-FR:home page lists several services; "Authentifier un titre ou un visa"]
      "PROMETE is a portal of several tools. The one that matters here is Authentifier un titre ou un visa (authenticate a certificate or an endorsement).",
    ],
    whatDockaConfirms: [
      // [src:portal-FR:"L'ensemble des brevets et certificats délivrés conformément à la Convention STCW ... sont enregistrés sur une base de données"] [src:lib-registry-countries:FR portalUrl]
      "The check goes to promete.din.developpement-durable.gouv.fr, the DAM's own database of STCW certificates and endorsements.",
      // [src:lib-registry-countries:FR inputs "Numéro de titre", "Numéro d'administration", "Numéro de version (if present)"]
      "Three inputs: Numéro de titre, Numéro d'administration, and Numéro de version (if present). The third is optional; only some documents carry it.",
      // [src:lib-registry-countries:FR capability auto] [src:real-features:timestamped result]
      "Live and automatic, time-stamped in Docka.",
      // [src:portal-FR:"Cette base de donnée est consultable en ligne, à tout moment."]
      "PROMETE states that all certificates issued under the STCW Convention are recorded in its database and that the database can be consulted online at any time.",
    ],
    diySteps: [
      // [src:portal-FR:home button "Authentifier un titre ou un visa"; next page link "Accéder à la base de gestion / Access to the database management"]
      "Open promete.din.developpement-durable.gouv.fr and choose Authentifier un titre ou un visa, then Accéder à la base de gestion (Access to the database management).",
      // [src:portal-FR:fields "N° du titre * / N° de version (1)"; footnote "(1) : Le numéro de version n'est obligatoire que pour les titres dont le numéro est > 10 000 000"] [src:lib-registry-countries:input labels "Numéro de titre", "Numéro de version (if present)"]
      "Fill in N° du titre (the Numéro de titre) and, when the certificate shows one, N° de version. The form's own footnote says the version number is mandatory only for certificates whose number is greater than 10 000 000.",
      // [src:portal-FR:field "N° du titulaire *"; button "Rechercher"] [src:lib-registry-countries:input label "Numéro d'administration"]
      "Fill in N° du titulaire (the holder's number, which Docka labels Numéro d'administration) and press Rechercher.",
    ],
    caveats: [
      // [src:portal-FR:search form in French at ConsulterTitreOuVisa?language=fr, 6 September 2026]
      "The search form is in French. Its address carries a language=fr parameter, and we did not see an English version of the form on 6 September 2026.",
      // [src:portal-FR:footnote on N° de version: mandatory only above 10 000 000]
      "The version number rule is precise: mandatory when the certificate number is greater than 10 000 000, otherwise it may be left empty.",
      // [src:lib-registry-countries:FR has no userNotes] [src:portal-FR:no coverage statement on the form]
      "The DAM publishes no coverage cut-off on the form. Docka has none to add.",
    ],
    sections: [
      {
        h2: "What PROMETE is",
        paras: [
          // [src:portal-FR:"Un outil de recherche de sessions de formation et d'authentification de documents professionnels maritimes, consultable de manière sécurisée depuis votre ordinateur, votre tablette ou votre smartphone."; footer "Promete version v1.6.7 production"]
          "PROMETE describes itself as a tool for searching training sessions and authenticating maritime professional documents, usable from a computer, a tablet or a phone. The version shown in its footer on 6 September 2026 was v1.6.7.",
          // [src:portal-FR:home page buttons: Rechercher une session de formation; Authentifier une attestation de suivi; Authentifier un titre ou un visa; Vérifier la validité d'un titre de sécurité; Authentifier un permis d'armement; Authentifier un certificat d'enregistrement professionnel; Vérifier la validité d'un Titre de plaisance; Consulter la fiche matricule d'un navire; Lister les SPRPGM établis en France]
          "Its home page lists nine services, among them Rechercher une session de formation, Authentifier une attestation de suivi, Authentifier un titre ou un visa, Vérifier la validité d'un titre de sécurité and Authentifier un permis d'armement. Only the titre ou visa search concerns seafarer certificates.",
        ],
      },
      {
        h2: "Titre and visa",
        paras: [
          // [src:portal-FR:"L'ensemble des brevets et certificats délivrés conformément à la Convention STCW"; search named "titre ou visa"]
          "In French usage a titre is the certificate itself (a brevet or a certificat) and a visa is the endorsement attached to it. PROMETE's authentication covers both under one search.",
          // [src:portal-FR:footer links "portail du marin", "portail de l'armateur"; the search needs no login]
          "The portal also links to the portail du marin and the portail de l'armateur, the seafarer's and the shipowner's portals, for account-based services. The authentication search needs no account.",
        ],
      },
    ],
    faq: [
      {
        q: "When is the numéro de version required on PROMETE?",
        // [src:portal-FR:footnote "(1) : Le numéro de version n'est obligatoire que pour les titres dont le numéro est > 10 000 000"] [src:lib-registry-countries:input label "Numéro de version (if present)"]
        a: "Only when the certificate number is greater than 10 000 000, according to the footnote on the search form. Docka labels the field Numéro de version (if present) for that reason.",
      },
      {
        q: "What is the numéro d'administration?",
        // [src:portal-FR:field "N° du titulaire *"] [src:lib-registry-countries:input label "Numéro d'administration"]
        a: "The holder's number, which PROMETE's form calls N° du titulaire. It is the second mandatory field on the form.",
      },
      {
        q: "Is PROMETE available in English?",
        // [src:portal-FR:"Access to the database management" link in English; search form in French on 6 September 2026]
        a: "The introduction page shows an English link (Access to the database management), but the search form we opened on 6 September 2026 was in French. The labels are translated on this page.",
      },
      {
        q: "Does PROMETE cover endorsements as well as certificates?",
        // [src:portal-FR:"Authentifier un titre ou un visa"; STCW certificates recorded in the database]
        a: "Yes. The search is named Authentifier un titre ou un visa, a certificate or an endorsement, and the portal says the STCW certificates France issues are recorded in the database it searches.",
      },
      {
        q: "Where do I find the numbers on a French certificate?",
        // [src:portal-FR:link "Où trouver ces N° ?" beside the fields]
        a: "The form has a link, Où trouver ces N° ? (where to find these numbers), beside the fields. Open it on the portal; we do not reproduce the document layout here.",
      },
    ],
    // [src:portal-FR:French-language search form]
    localHint: "French. The three labels are translated below.",
  },
];

/** The day the six pages went live on docka.me; the WebPage `datePublished`. */
// [src:real-features:the six registry pages shipped in the 2026-09-07 deploy (docka.me/version.txt 79d707a)]
export const REGISTRY_PAGES_PUBLISHED_ISO = "2026-09-07";

const clean = (s: string) => plainPunct(s);

/** The six registry pages, style-guide-normalised at the data layer (plan S1). */
export const REGISTRY_PAGES: readonly RegistryPageData[] = Object.freeze(
  RAW.map((p) => ({
    ...p,
    slug: REGISTRY_PAGE_SLUGS[p.code],
    country: clean(p.country),
    title: clean(p.title),
    description: clean(p.description),
    h1: clean(p.h1),
    ogAlt: clean(p.ogAlt),
    intro: p.intro.map(clean),
    whatDockaConfirms: p.whatDockaConfirms.map(clean),
    diySteps: p.diySteps.map(clean),
    caveats: p.caveats.map(clean),
    sections: p.sections.map((s) => ({ h2: clean(s.h2), paras: s.paras.map(clean) })),
    faq: p.faq.map(({ q, a }) => ({ q: clean(q), a: clean(a) })),
    localHint: clean(p.localHint),
  }))
);

/** One page by slug (e.g. "united-kingdom"), or undefined. */
export function registryPage(slug: string): RegistryPageData | undefined {
  return REGISTRY_PAGES.find((p) => p.slug === slug);
}

/** `/registries/<slug>` for a page. */
export function registryPagePathFor(p: Pick<RegistryPageData, "slug">): string {
  return `/registries/${p.slug}`;
}
