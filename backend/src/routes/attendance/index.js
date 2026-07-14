const router = require('express').Router();
const { authenticate } = require('../../middleware/auth');

router.use(authenticate);

router.use(require('./daily'));
router.use(require('./monthly'));
router.use(require('./manual'));
router.use(require('./processing'));
router.use(require('./movement'));
router.use(require('./rebuild'));

module.exports = router;
