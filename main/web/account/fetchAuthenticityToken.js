import ky from 'ky';
import getUrl from '../requestManager';

let DomParser = require('react-native-html-parser').DOMParser;

export async function fetchLoginAuthenticityToken() {
  try {
    let html = await ky.get("https://archiveofourown.org/users/login").text();
    html = html.replace("<br \\>", ''); //Before you ask, no. I don't know. I don't need them anyway. /shrug
    if (html.includes("You are already logged in to an account. Please log out and try again.")) {
      throw "already logged in.";
    }
    console.log(html);
    return new DomParser().parseFromString(html, "text/html")
      .getElementById("new_user") //Get the form
      .childNodes[0].getAttribute('value') //Get the hidden element and it's value
  } catch (e) {
    console.error("An error occurred while running fetchLoginAuthenticityToken", e);
    throw e;
  }
}

export async function fetchKudoAuthenticityToken(workId) {
  try {
    //https, not http: iOS App Transport Security refuses cleartext requests
    //outright, so the old http:// url could never load and every kudo failed.
    //view_adult=true, or explicit works answer with the "this work could have
    //adult content" interstitial, which carries no kudo form.
    const html = await getUrl(
      `https://archiveofourown.org/works/${workId}?view_adult=true`,
    );

    //Check the interstitial first: it renders inside the normal layout, so
    //the page still carries other forms' tokens and would otherwise pass the
    //checks below with the wrong one.
    if (html.includes('This work could have adult content')) {
      throw new Error('Could not load the work page (adult content gate).');
    }

    //Same trick as markForLater, the parser trips over AO3's markup often
    //enough that matching the input directly is simply more reliable.
    //Scope strictly to the kudo form. The first authenticity_token on a work
    //page belongs to the login/search forms at the top, never to #new_kudo,
    //so falling back to a whole-page scan would send the wrong token.
    const kudoFormMatch = html.match(
      /<form[^>]*id="new_kudo"[\s\S]*?<\/form>/i,
    );
    if (!kudoFormMatch) {
      throw new Error('Kudo form not found on the work page.');
    }

    const form = kudoFormMatch[0];
    const token =
      form.match(/name="authenticity_token"[^>]*?value="([^"]+)"/i) ||
      form.match(/value="([^"]+)"[^>]*?name="authenticity_token"/i);

    if (!token) {
      throw new Error('Authenticity token not found in the kudo form.');
    }

    return token[1];

  } catch (e) {
    console.error("An error occurred while running fetchKudoAuthenticityToken", e);
    throw e; // Re-throw to allow caller to handle
  }
}
