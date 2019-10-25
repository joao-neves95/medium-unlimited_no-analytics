import intercept from './cookie_interceptors'; //Importing just to make sure the interceptors are registered.
import {log, init, hasMembershipPrompt} from './utils';
import {incrementReadCountAndGet, getUserId} from './storage';
import {FETCH_CONTENT_MESSAGE, FETCH_USER_ID} from './constants';

//Initialize global handlers
init();

const inProgressUrls = {};

intercept(inProgressUrls);

chrome.runtime.onMessage.addListener((request, _, sendResponse) => {
  switch (request.type) {
    case FETCH_CONTENT_MESSAGE:
      return _processContentRequest(request, sendResponse);
    case FETCH_USER_ID:
      return _processUserIdRequest(sendResponse);
  }
});

function _processUserIdRequest(sendResponse) {
  sendResponse({status: 'SUCCESS', userId: getUserId()});
}

function _processContentRequest(request, sendResponse) {
  log('Fetching content for', request.url);
  _fetch(request.url)
    .then(async responseData => {
      const doc = document.createElement('html');
      doc.innerHTML = responseData.body;
      const hadMembershipPrompt = hasMembershipPrompt(doc);
      const content = extractArticleContent(doc);
      const counter = incrementReadCountAndGet();
      let externalUrl = extractExternalUrlInContent(doc);
      let isGoogleResult = false;
      if (hadMembershipPrompt && !externalUrl) {
        externalUrl = await getUrlFromGoogleSearch(request.url)
          .catch(err => log('Error while searching', err));
        isGoogleResult = true;
      }
      sendResponse({ status: 'SUCCESS', content, counter, hadMembershipPrompt, externalUrl });
    })
    .catch(error => {
      sendResponse({status: 'ERROR', error: JSON.stringify(error)});
    });
  return true;
}

async function getUrlFromGoogleSearch(url) {
  const slugs = url.split('/');
  const lastSlug = slugs[slugs.length - 1];
  const words = lastSlug.split('-');
  const requiredSlug = words.splice(0, words.length - 1).join('-');
  const response = await _fetch(`https://www.google.com/search?q=${requiredSlug}`);
  const doc = document.createElement('html');
  doc.innerHTML = response.body;
  const searchElement = doc.querySelector('#search');
  if (!searchElement) {
    return;
  }
  const links = searchElement.getElementsByTagName('a');
  let requiredLink = null;
  for (const link of links) {
    if (isValidArticleUrl(link.href)) {
      requiredLink = link;
      break;
    }
  }
  if (!requiredLink) {
    return;
  }
  return requiredLink.href;
}

function isValidArticleUrl(url) {
  return (
    url &&
    url.indexOf('medium.com') === -1 &&
    url.indexOf('webcache.googleusercontent.com') === -1 &&
    url.indexOf('chrome-extension://') === -1
  );
}

function processImageTags(sections) {
  for (const section of sections) {
    const imgs = section.getElementsByTagName('img');
    for (const img of imgs) {
      if (
        !img.src &&
        img.nextSibling &&
        img.nextSibling.tagName === 'NOSCRIPT'
      ) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = img.nextSibling.innerHTML;
        img.parentNode.replaceChild(tempDiv.children[0], img);
      }
    }
  }
  return sections;
}

function newArticleExtraction(doc) {
  const sections = processImageTags(
    doc.getElementsByTagName('article')[0].children[2].children
  );
  const styles = doc.getElementsByTagName('style');
  const articleElements = [
    ...Array.from(styles),
    ...Array.from(sections),
  ];
  return articleElements;
}

function extractArticleContent(doc) {
  let articleElements = doc.getElementsByClassName('postArticle-content');
  if (articleElements.length === 0) {
    articleElements = newArticleExtraction(doc);
  }
  const content = Array.from(
    articleElements
  ).reduce(
    (accumulator, section) => {
      accumulator.appendChild(section);
      return accumulator;
    },
    document.createElement('div')
  );
  return new XMLSerializer().serializeToString(content);
}

function extractExternalUrlInContent(doc) {
  const canonicalUrlElement = doc.querySelector('link[rel=canonical]');
  if (!canonicalUrlElement) {
    return;
  }
  const canonicalUrl = canonicalUrlElement.getAttribute('href');
  if (!canonicalUrl || canonicalUrl.indexOf('medium.com/') > -1) {
    return;
  }
  return canonicalUrl;
}

function _fetch(url) {
  inProgressUrls[url] = true;
  return fetch(url, { credentials: 'include' }).then(response => {
    return response.text().then(body => {
      delete inProgressUrls[url];
      return { status: response.status, body };
    });
  }).catch(err => {
    delete inProgressUrls[url];
    throw err;
  });
}
