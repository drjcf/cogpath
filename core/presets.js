/**
 * Named paths offered by the composer. Each is a complete linear path in the DSL; the composer loads one and the
 * designer edits from there. Keep the forms concrete: the synthesize form is what the item's key will be.
 */
export const PRESETS = [
  { id: 'management', name: 'Management decision', path: 'recall(4) > analyze(causal) > evaluate(efficacy, safety) > synthesize(management plan)', when: 'A clinical decision where a case feature changes the plan the source would suggest.' },
  { id: 'appraisal', name: 'Evidence appraisal', path: 'recall(4) > analyze(contrast) > evaluate(validity, generalizability) > synthesize(evidence appraisal)', when: 'Conflicting or limited findings; the item asks what the evidence does and does not support.' },
  { id: 'protocol', name: 'Mechanism to protocol', path: 'recall(4) > analyze(mechanism) > evaluate(safety, feasibility) > synthesize(operative protocol)', when: 'A mechanism in the source that a protocol must respect under a constraint the source did not cover.' },
  { id: 'counseling', name: 'Counseling', path: 'recall(4) > analyze(comparison) > evaluate(benefit, burden) > synthesize(counseling plan)', when: 'What to tell a patient who asks for a guarantee or a shortcut the source does not justify.' },
  { id: 'surveillance', name: 'Surveillance', path: 'recall(5) > analyze(comparison) > evaluate(sensitivity, cost) > synthesize(surveillance protocol)', when: 'How often and where to look, given the source\'s rates and the costs of looking.' },
];
