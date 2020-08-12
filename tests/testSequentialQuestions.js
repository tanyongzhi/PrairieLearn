const util = require('util');
const assert = require('chai').assert;
const { step } = require('mocha-steps');

const config = require('../lib/config');
const sqldb = require('@prairielearn/prairielib/sql-db');
const sqlLoader = require('@prairielearn/prairielib/sql-loader');
const sql = sqlLoader.loadSqlEquiv(__filename);

const helperServer = require('./helperServer');
const helperQuestion = require('./helperQuestion');
const helperClient = require('./helperClient');
const helperExam = require('./helperExam');

describe('Assessment that forces students to complete questions in-order', function() {
  this.timeout(60000);

  const context = {};
  context.siteUrl = `http://localhost:${config.serverPort}`;
  context.baseUrl = `${context.siteUrl}/pl`;
  context.courseInstanceBaseUrl= `${context.baseUrl}/course_instance/1`;

  before('set up testing server', async function() {
    await util.promisify(helperServer.before().bind(this))();
    const results = await sqldb.queryOneRowAsync(sql.select_exam9, []);
    context.assessmentId = results.rows[0].id;
    context.assessmentUrl = `${context.courseInstanceBaseUrl}/assessment/${context.assessmentId}/`;
    context.instructorAssessmentQuestionsUrl = `${context.courseInstanceBaseUrl}/instructor/assessment/${context.assessmentId}/questions/`;
  });
  after('shut down testing server', helperServer.after);

  step('Minimum advancement score is computed correctly for each question', async function() {
    const response = await helperClient.fetchCheerio(context.instructorAssessmentQuestionsUrl, { method: 'GET' });
    assert.isTrue(response.ok);

    const expectedPercentages = [25, 0, 60, 100, 100];
    const computedPercentages = response.$('.pl-sequence-prev-unlock-score').map((i, elem) => {
      // turn string "25%" -> number 25
      return Number(response.$(elem).text().trim().slice(0,-1));
    }).get();
    assert.deepEqual(expectedPercentages, computedPercentages);
  });

  step('Questions are locked/unlocked properly on student assessment page', async function() {
    const assessmentCreateResponse = await helperClient.fetchCheerio(context.assessmentUrl);
    helperClient.extractAndSaveCSRFToken(context, assessmentCreateResponse.$, 'form');
    const form = {
      __action: 'newInstance',
      __csrf_token: context.__csrf_token,
    };
    const response = await helperClient.fetchCheerio(context.assessmentUrl, { method: 'POST', form });
    assert.isTrue(response.ok);

    // We should have been redirected to the assessment instance
    const assessmentInstanceUrl = response.url;
    assert.include(assessmentInstanceUrl, '/assessment_instance/');
    context.assessmentInstanceUrl = assessmentInstanceUrl;

    const expectedLocks = [false, true, false, true, true];
    const computedLocks = response.$('table#assessment-questions tbody tr').map((i, elem) => {
      return response.$(elem).hasClass('pl-sequence-locked');
    }).get();
    assert.deepEqual(expectedLocks, computedLocks);

    context.questionUrl = context.siteUrl + response.$('a:contains("Question 3")').attr('href');
  });

  step('Accessing Question 4 returns a 403', async function() {
    const results = await sqldb.queryOneRowAsync(sql.select_question4, []);
    context.lockedQuestionId = results.rows[0].id;
    context.lockedQuestionUrl = `${context.courseInstanceBaseUrl}/instance_question/${context.lockedQuestionId}/`;
    const response = await helperClient.fetchCheerio(context.lockedQuestionUrl);
    assert.isTrue(!response.ok);
    assert.equal(response.status, 403);
  });

  step('Question 4 URL is not exposed from student assessment page', async function() {
    const response = await helperClient.fetchCheerio(context.assessmentUrl);
    assert.isTrue(response.ok);
    assert.equal(response.$(`a[href*="instance_question/${context.lockedQuestionId}"]`).length, 0);
  });

  step('Question 3 nav buttons are locked before any submissions', async function() {
    const response = await helperClient.fetchCheerio(context.questionUrl);
    assert.isTrue(response.ok);

    assert.isTrue(response.$('#question-nav-prev').hasClass('pl-sequence-locked'));
    assert.isTrue(response.$('#question-nav-next').hasClass('pl-sequence-locked'));
  });

  async function submitQuestion(score, questionUrl) {
    const preSubmissionResponse = await helperClient.fetchCheerio(questionUrl);
    assert.isTrue(preSubmissionResponse.ok);
    helperClient.extractAndSaveCSRFToken(context, preSubmissionResponse.$, '.question-form');
    context.__variant_id = preSubmissionResponse.$('.question-form input[name="__variant_id"]').attr('value');
    const form = {
      '__action': 'grade',
      '__variant_id': context.__variant_id,
      's': String(score),
      '__csrf_token': context.__csrf_token
    }

    const response = await helperClient.fetchCheerio(questionUrl, { method: 'POST', form });
    assert.isTrue(response.ok);

    return response;
  }

  step('Submitting 50% on Question 3 does not unlock Question 4', async function() {
    const response = await submitQuestion(50, context.questionUrl);
    assert.isTrue(response.$('#question-nav-next').hasClass('pl-sequence-locked'));
  });

  step('Submitting 60% on Question 3 unlocks Question 4', async function() {
    const response = await submitQuestion(60, context.questionUrl);
    assert.isFalse(response.$('#question-nav-next').hasClass('pl-sequence-locked'));
  });

  step('Submitting 0% on Question 3 leaves Question 4 unlocked', async function() {
    const response = await submitQuestion(60, context.questionUrl);
    assert.isFalse(response.$('#question-nav-next').hasClass('pl-sequence-locked'));
  });

  step('Accessing Question 4 no longer returns a 403 and Question 5 is locked', async function() {
    const response = await helperClient.fetchCheerio(context.lockedQuestionUrl);
    assert.isTrue(response.ok);

    assert.isTrue(response.$('#question-nav-next').hasClass('pl-sequence-locked'));
  });

  step('Submitting 0% on Question 4 unlocks Question 5 (run out of attempts)', async function() {
    const response = await submitQuestion(0, context.lockedQuestionUrl);
    assert.isTrue(response.ok);

    assert.isFalse(response.$('#question-nav-next').hasClass('pl-sequence-locked'));
  });
});

